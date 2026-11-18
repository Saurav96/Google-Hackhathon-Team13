"""Turns an advisor answer into a PDF grant memo with a few plain charts."""

import io
import re
from datetime import date
from html import escape

from fastapi import APIRouter
from fastapi.responses import Response
from pydantic import BaseModel
from reportlab.graphics.shapes import Drawing, Line, Polygon, Rect, String
from reportlab.lib import colors
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import KeepTogether, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from microgrants import analysis, data, tools
from microgrants.applicants import APPLICANTS

INK = colors.HexColor("#171c30")
SOFT = colors.HexColor("#5a6482")
LINE = colors.HexColor("#d3d9e8")
ACCENT = colors.HexColor("#3852d6")
SAFE = colors.HexColor("#0c8f73")
WIDTH = 6.5 * inch

BODY = ParagraphStyle("body", fontName="Helvetica", fontSize=10.5, leading=15, textColor=INK, spaceAfter=6)
SMALL = ParagraphStyle("small", parent=BODY, fontSize=8.5, leading=11.5, textColor=SOFT)
H1 = ParagraphStyle("h1", parent=BODY, fontName="Helvetica-Bold", fontSize=20, leading=24, spaceAfter=2)
H2 = ParagraphStyle("h2", parent=BODY, fontName="Helvetica-Bold", fontSize=12.5, leading=16, spaceBefore=10, spaceAfter=4)
BULLET = ParagraphStyle("bullet", parent=BODY, leftIndent=14, bulletIndent=3, spaceAfter=3)
CELL = ParagraphStyle("cell", parent=BODY, fontSize=8.5, leading=11, spaceAfter=0)

router = APIRouter()


class Snapshot(BaseModel):
    """The report exactly as the officer sees it. Exports are built from this, never from defaults."""

    title: str = "Relief funding recommendation"
    revision: int = 1
    scope: str = "allocation"
    budget_usd: int = 0
    selection_ids: list[str] = []
    narrative: str = ""
    narratives: dict[str, str] = {}
    subject_id: str = ""
    employer_block_id: str = ""
    notes_markdown: str = ""
    needs_update: bool = False


class ReportRequest(BaseModel):
    markdown: str = ""
    question: str = ""
    snapshot: Snapshot | None = None
    format: str = "pdf"


def _inline(text: str) -> str:
    """Markdown emphasis to the small tag set reportlab understands."""
    text = escape(text, quote=False)
    text = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", text)
    text = re.sub(r"(?<!\*)\*(?!\s)(.+?)(?<!\s)\*(?!\*)", r"<i>\1</i>", text)
    return re.sub(r"`(.+?)`", r"<font face='Courier'>\1</font>", text)


def _table(rows: list[list[str]]) -> Table:
    columns = max(len(r) for r in rows)
    rows = [r + [""] * (columns - len(r)) for r in rows]
    table = Table([[Paragraph(_inline(c), CELL) for c in r] for r in rows], colWidths=[WIDTH / columns] * columns, repeatRows=1)
    table.setStyle(TableStyle([
        ("GRID", (0, 0), (-1, -1), 0.5, LINE),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eef1f8")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4),
    ]))
    return table


def _wide_table(rows: list[list[str]], shares: list[float]) -> Table:
    table = Table([[Paragraph(_inline(c), CELL) for c in r] for r in rows], colWidths=[WIDTH * share for share in shares], repeatRows=1)
    table.setStyle(TableStyle([
        ("GRID", (0, 0), (-1, -1), 0.5, LINE),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eef1f8")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4),
    ]))
    return table


def _body(markdown: str) -> list:
    markdown = markdown.split("<follow_ups>")[0]
    flow, table_rows = [], []

    def flush():
        if table_rows:
            flow.extend([_table(list(table_rows)), Spacer(1, 6)])
            table_rows.clear()

    for raw in markdown.splitlines():
        line = raw.strip()
        if line.startswith("|"):
            cells = [c.strip() for c in line.strip("|").split("|")]
            if not all(re.fullmatch(r":?-{2,}:?", c) for c in cells):
                table_rows.append(cells)
            continue
        flush()
        if not line or re.fullmatch(r"[-*_]{3,}", line):
            continue
        heading = re.match(r"#{1,6}\s+(.*)", line)
        bullet = re.match(r"(?:[-*+]|\d+\.)\s+(.*)", line)
        if heading:
            flow.append(Paragraph(_inline(heading.group(1)), H2))
        elif bullet:
            flow.append(Paragraph(_inline(bullet.group(1)), BULLET, bulletText="•"))
        else:
            flow.append(Paragraph(_inline(line), BODY))
    flush()
    return flow


def _bars(title: str, rows: list[tuple[str, float, str, colors.Color]], width: float = WIDTH / 2 - 8, value_w: int = 44, label_w: int = 100) -> Drawing:
    """Horizontal bars with the value written at the end of each one."""
    height = 22 + 20 * len(rows)
    drawing = Drawing(width, height)
    drawing.add(String(0, height - 11, title, fontName="Helvetica-Bold", fontSize=9, fillColor=INK))
    top = max(value for _, value, _, _ in rows) or 1
    for i, (label, value, shown, color) in enumerate(rows):
        y = height - 36 - 20 * i
        shown_label = label if len(label) <= label_w // 5 else label[: label_w // 5 - 1] + "…"
        drawing.add(String(0, y + 3, shown_label, fontName="Helvetica", fontSize=8.5, fillColor=SOFT))
        full = width - label_w - value_w
        drawing.add(Rect(label_w, y, full, 11, fillColor=colors.HexColor("#eef1f8"), strokeColor=None))
        drawing.add(Rect(label_w, y, max(2, full * value / top), 11, fillColor=color, strokeColor=None))
        drawing.add(String(width - value_w + 5, y + 3, shown, fontName="Helvetica-Bold", fontSize=8.5, fillColor=INK))
    return drawing


def _subject(markdown: str) -> dict | None:
    """The business the memo is about: the first registry name that appears in the text."""
    text = markdown.lower()
    found = [(text.find(b["name"].lower()), -len(b["name"]), b) for b in data.directory().values() if len(b["name"]) > 4]
    found = [f for f in found if f[0] >= 0]
    return min(found, key=lambda f: (f[0], f[1]))[2] if found else None


def _at_a_glance(business: dict) -> list:
    cascade = tools.trace_cascade(business["business_id"])
    hood = cascade["neighborhood"]
    stats = [
        (str(cascade["exposed_total"]), "businesses lose a supplier"),
        (str(cascade["exposed_by_hops"].get("1_hop", 0)), "buy from it directly"),
        (str(cascade["exposed_not_in_applicant_queue"]), "of them never applied"),
    ]
    number = ParagraphStyle("n", parent=BODY, fontName="Helvetica-Bold", fontSize=20, leading=22, spaceAfter=0)
    boxes = Table([[[Paragraph(n, number), Paragraph(label, SMALL)] for n, label in stats]], colWidths=[WIDTH / 3] * 3)
    boxes.setStyle(TableStyle([("BOX", (0, 0), (-1, -1), 0.5, LINE), ("INNERGRID", (0, 0), (-1, -1), 0.5, LINE),
                               ("LEFTPADDING", (0, 0), (-1, -1), 10), ("TOPPADDING", (0, 0), (-1, -1), 8), ("BOTTOMPADDING", (0, 0), (-1, -1), 8)]))
    pct = lambda x: f"{100 * x:.1f}%"  # noqa: E731
    need = _bars("Poverty rate", [("This tract", hood["poverty_rate"], pct(hood["poverty_rate"]), ACCENT),
                                  ("Corridor", hood["corridor_average"]["poverty_rate"], pct(hood["corridor_average"]["poverty_rate"]), SOFT)])
    cars = _bars("Households with no vehicle", [("This tract", hood["no_vehicle_rate"], pct(hood["no_vehicle_rate"]), ACCENT),
                                                ("Corridor", hood["corridor_average"]["no_vehicle_rate"], pct(hood["corridor_average"]["no_vehicle_rate"]), SOFT)])
    return [
        Paragraph(f"{escape(business['name'])} at a glance", H2),
        Paragraph(f"{escape(business['address'])}. {escape(business['network_role'])}. Census tract {hood['census_tract']}.", SMALL),
        Spacer(1, 4), boxes, Spacer(1, 10), Table([[need, cars]], colWidths=[WIDTH / 2] * 2), Spacer(1, 4),
    ]


def _plan_chart() -> list:
    plan = analysis.plan_budget()
    if not plan["plan"]:
        return []
    rows = [(s["name"], s["newly_protected"], f"{s['newly_protected']}  (${s['grant_usd']:,})", SAFE) for s in plan["plan"]]
    return [
        Paragraph("The advisor's split of the budget", H2),
        Paragraph(f"${plan['plan_total_usd']:,} of ${plan['budget_usd']:,} across {len(rows)} grants protects "
                  f"{plan['plan_distinct_businesses_protected']} distinct businesses. Each bar counts only businesses "
                  "not already protected by an earlier grant.", SMALL),
        Spacer(1, 4), _bars("Newly protected businesses per grant", rows, WIDTH, 84), Spacer(1, 4),
    ]


def _footer(canvas, doc) -> None:
    canvas.saveState()
    canvas.setFont("Helvetica", 7.5)
    canvas.setFillColor(SOFT)
    canvas.drawString(inch, 0.55 * inch, "Public records: businesses, census data, loans. Modeled: supply and footfall links. "
                      "A grant changes a probability, not an outcome.")
    canvas.drawRightString(LETTER[0] - inch, 0.55 * inch, f"Page {doc.page}")
    canvas.restoreState()


def build(markdown: str, question: str = "") -> bytes:
    story = [
        Paragraph("Grant memo", H1),
        Paragraph(f"To: Economic development officer, Central Market relief fund &nbsp;&nbsp; From: Grant advisor agent "
                  f"&nbsp;&nbsp; Date: {date.today():%B %d, %Y}", SMALL),
    ]
    if question:
        story.append(Paragraph(f"Question asked: {escape(question[:300])}", SMALL))
    story.append(Table([[""]], colWidths=[WIDTH], rowHeights=[4], style=TableStyle([("LINEBELOW", (0, 0), (-1, -1), 1.2, INK)])))
    story.append(Spacer(1, 8))
    subject = _subject(markdown)
    if subject:
        story.extend(_at_a_glance(subject))
    if re.search(r"split|budget|allocat", markdown, re.I):
        story.extend(_plan_chart())
    story.append(Paragraph("The advisor's memo", H2))
    story.extend(_body(markdown))
    buffer = io.BytesIO()
    SimpleDocTemplate(buffer, pagesize=LETTER, leftMargin=inch, rightMargin=inch, topMargin=0.8 * inch, bottomMargin=0.9 * inch,
                      title="Grant memo", author="Central Market relief desk").build(story, onFirstPage=_footer, onLaterPages=_footer)
    return buffer.getvalue()


LIMITS = [
    "Public records: business identity and address, census tract demographics, employer block job counts, SBA loan records.",
    "Modeled: supply links (federal industry purchase rates assigned to nearby pairs) and worker spending links (block job counts shared among nearby businesses, nearer ones weighted more).",
    "Scenario inputs: the applicant queue, the requested amounts and the budget are demo inputs, not registry data.",
    "Reach counts businesses with a modeled link to a funded business. It is not a count of businesses saved.",
    "No revenue, rent, jobs per business or distress data exists. A grant changes a probability, not an outcome.",
    "Only 4 SBA loans match this corridor and none were charged off, so results cannot be checked against real failures.",
]


def _facts(snapshot: Snapshot) -> dict:
    """Every number in an export, computed once for the selection and budget in the snapshot."""
    evaluation = analysis.evaluate_selection(snapshot.selection_ids, snapshot.budget_usd)
    directory = data.directory()
    chosen = [g["business_id"] for g in evaluation["grants"]]
    covered: set[str] = set()
    for business_id in chosen:
        covered |= set(data.exposed_set(business_id))

    grants = []
    for grant in evaluation["grants"]:
        cascade = tools.trace_cascade(grant["business_id"])
        chains = []
        for chain in cascade["strongest_chains"][:3] + cascade["furthest_chains"][:2]:
            if chain["chain"] not in [c["chain"] for c in chains]:
                chains.append(chain)
        grants.append({**grant, "address": directory[grant["business_id"]]["address"], "cascade": cascade, "chains": chains})

    others = []
    left = evaluation["unallocated_usd"]
    for applicant in APPLICANTS:
        business = directory.get(applicant["business_id"])
        if business is None or applicant["business_id"] in chosen:
            continue
        exposed = set(data.exposed_set(applicant["business_id"]))
        new = len(exposed - covered)
        if business["network_role"].startswith("Ubiquitous Hub"):
            why = "Ubiquitous Hub. It is the only local producer of its input, so the model gives it every nearby buyer. A weak signal."
        elif not exposed:
            why = "No modeled downstream links. The graph cannot argue for it. It needs a human case."
        elif applicant["requested_usd"] > left:
            why = f"Asks ${applicant['requested_usd']:,} with ${max(left, 0):,} left. Would add {new} businesses to reach."
        else:
            why = f"Would add {new} businesses to reach. {business['same_industry_peers']} same industry peers could absorb its buyers."
        others.append({"name": business["name"], "reach": len(exposed), "peers": business["same_industry_peers"],
                       "requested_usd": applicant["requested_usd"], "why": why})

    scenarios = None
    if grants:
        lead = grants[0]
        runner_up = grants[1]["business_id"] if len(grants) > 1 else ""
        scenarios = analysis.grant_impact_scenarios(lead["business_id"], lead["grant_usd"], runner_up)

    closing = None
    if snapshot.employer_block_id:
        from microgrants import closure

        result = closure.simulate_employer_closure(snapshot.employer_block_id)
        closing = None if "error" in result else result
    narratives = dict(snapshot.narratives)
    if snapshot.narrative.strip() and "recommendation" not in narratives:
        narratives["recommendation"] = snapshot.narrative
    return {"evaluation": evaluation, "grants": grants, "others": others, "scenarios": scenarios,
            "subject": directory.get(snapshot.subject_id), "closing": closing, "narratives": narratives}


def _summary(ev: dict) -> str:
    if not ev["grants"]:
        return "No grants are selected in this revision."
    return (f"Propose {len(ev['grants'])} grant{'s' if len(ev['grants']) > 1 else ''} totaling ${ev['total_usd']:,}. "
            f"Their modeled reach includes {ev['distinct_businesses_in_reach']} distinct businesses. "
            "These estimates do not guarantee survival.")


def _arrow(chain: str) -> str:
    return chain.replace(" -> ", " → ")


def markdown_for(snapshot: Snapshot) -> str:
    facts = _facts(snapshot)
    ev, notes = facts["evaluation"], facts["narratives"]
    out = [
        f"# {snapshot.title}", "",
        f"Interactive Grant Memo, revision {snapshot.revision}, {date.today():%B %d, %Y}."
        + (" Draft: some sections need an update." if snapshot.needs_update else ""), "",
        "## 1. Recommendation", "",
        f"- Budget: ${ev['budget_usd']:,}",
        f"- Proposed: ${ev['total_usd']:,} across {len(ev['grants'])} grants",
        f"- Unallocated: ${ev['unallocated_usd']:,}" + (" (over budget)" if ev["over_budget"] else ""),
        f"- Distinct businesses in modeled reach: {ev['distinct_businesses_in_reach']}", "",
        notes.get("recommendation", "").strip() or _summary(ev), "",
    ]
    if facts["grants"]:
        out += ["| Business | Address | Role | Proposed grant | Newly in modeled reach |", "|---|---|---|---|---|"]
        out += [f"| {g['name']} | {g['address']} | {g['network_role']} | ${g['grant_usd']:,} | {g['newly_protected']} |" for g in facts["grants"]]
        out += ["", "## 2. What each grant protects, and the traversal", ""]
        for g in facts["grants"]:
            c = g["cascade"]
            out += [
                f"**{g['name']}.** {c['exposed_total']} businesses within two steps ({c['exposed_by_hops'].get('1_hop', 0)} direct). "
                f"{c['exposed_not_in_applicant_queue']} are outside the demo applicant queue. "
                f"Same industry peers in the corridor: {c['replaceability']['same_industry_peers_in_corridor']}.", "",
            ]
            out += [f"- {_arrow(ch['chain'])} ({ch['hops']} step{'s' if ch['hops'] > 1 else ''}, {100 * ch['path_strength']:.2f}% of buyer input spending)" for ch in g["chains"]]
            out.append("")
    if notes.get("impact"):
        out += [notes["impact"].strip(), ""]
    if facts["others"]:
        out += ["## 3. Why not the others", ""]
        if notes.get("alternatives"):
            out += [notes["alternatives"].strip(), ""]
        out += ["| Business | Reach | Same industry peers | Requested | Why it is not selected |", "|---|---|---|---|---|"]
        out += [f"| {o['name']} | {o['reach']} | {o['peers']} | ${o['requested_usd']:,} | {o['why']} |" for o in facts["others"]]
        out.append("")
    sc = facts["scenarios"]
    if sc and "error" not in sc:
        out += [f"## 4. What the grant changes: {sc['business']}, ${sc['grant_usd']:,}", ""]
        if notes.get("scenarios"):
            out += [notes["scenarios"].strip(), ""]
        out += ["| If we assume | Closure risk without a grant | Grant cuts the risk by | Businesses shielded | Cost per business |", "|---|---|---|---|---|"]
        for name, row in sc["scenarios"].items():
            cost = f"${row['cost_per_business_shielded_usd']:,}" if row["cost_per_business_shielded_usd"] else "n/a"
            out.append(f"| {name.title()} | {100 * row['closure_risk_without_grant']:.0f}% | {100 * row['risk_cut_by_grant']:.0f}% | {row['expected_businesses_shielded']:.1f} | {cost} |")
        out += ["", sc["what_is_assumed"], ""]
        if sc.get("flip_condition"):
            out += [sc["flip_condition"], ""]
    if facts["closing"]:
        r = facts["closing"]
        out += [
            f"## Employer closure: block {r['employer_block']['block_id']}", "",
            f"- {r['employer_block']['jobs']:,} workers leave",
            f"- {r['first_order_total']} businesses lose modeled worker demand",
            f"- {r['second_order_total']} suppliers behind them are exposed", "",
        ]
    if ev["audit"]:
        need, bias = ev["audit"]["need"], ev["audit"]["structural_bias_in_the_model"]
        out += ["## 5. Who the neighborhood is", ""]
        if notes.get("neighborhood"):
            out += [notes["neighborhood"].strip(), ""]
        out += [
            f"- Funded tracts average {100 * need['funded_avg_tract_poverty']:.1f}% poverty, against {100 * need['corridor_avg_tract_poverty']:.1f}% for the corridor.",
            f"- Households with no vehicle: {100 * need['funded_avg_no_vehicle']:.1f}% in funded tracts, against {100 * need['corridor_avg_no_vehicle']:.1f}% for the corridor.",
            f"- Model bias: food service is {100 * bias['food_service_share_of_all_businesses']:.1f}% of businesses but "
            f"{100 * bias['food_service_share_of_businesses_with_a_cascade']:.1f}% of businesses with any modeled cascade.", "",
        ]
    if snapshot.notes_markdown.strip():
        out += ["## Advisor memo", "", snapshot.notes_markdown.split("<follow_ups>")[0].strip(), ""]
    out += ["## 6. Evidence and limitations", ""] + [f"- {item}" for item in LIMITS]
    return "\n".join(out) + "\n"


TEAL = colors.HexColor("#0b8484")
NAVY = colors.HexColor("#152a43")
MIST = colors.HexColor("#eef4f6")
RULE = colors.HexColor("#d9e2e7")
GRAY = colors.HexColor("#5f6f7c")
AMBER_BG = colors.HexColor("#fff3dc")
AMBER = colors.HexColor("#9a6508")
NUMBER_WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"]

T_EYEBROW = ParagraphStyle("t_eyebrow", fontName="Helvetica-Bold", fontSize=8.5, leading=11, textColor=TEAL, spaceAfter=7)
T_TITLE = ParagraphStyle("t_title", fontName="Helvetica-Bold", fontSize=25, leading=29, textColor=NAVY, spaceAfter=4)
T_LEDE = ParagraphStyle("t_lede", fontName="Helvetica", fontSize=10.5, leading=14, textColor=GRAY, spaceAfter=14)
T_BODY = ParagraphStyle("t_body", fontName="Helvetica", fontSize=10, leading=14.5, textColor=NAVY, spaceAfter=6)
T_NOTE = ParagraphStyle("t_note", fontName="Helvetica", fontSize=8, leading=11, textColor=GRAY, spaceAfter=4)
T_TH = ParagraphStyle("t_th", fontName="Helvetica-Bold", fontSize=7.5, leading=10, textColor=colors.white)
T_TD = ParagraphStyle("t_td", fontName="Helvetica", fontSize=9, leading=12, textColor=NAVY)
T_BIG = ParagraphStyle("t_big", fontName="Helvetica-Bold", fontSize=24, leading=28, textColor=NAVY, spaceAfter=3)
T_LABEL = ParagraphStyle("t_label", fontName="Helvetica", fontSize=9, leading=12, textColor=GRAY)


def _sub(number: int, title: str) -> Table:
    """A numbered sub heading: a small teal number beside a bold title."""
    num = ParagraphStyle("t_num", fontName="Helvetica-Bold", fontSize=9.5, leading=17, textColor=TEAL)
    head = ParagraphStyle("t_head", fontName="Helvetica-Bold", fontSize=14, leading=17, textColor=NAVY)
    table = Table([[Paragraph(f"{number:02d}", num), Paragraph(escape(title), head)]], colWidths=[26, WIDTH - 26])
    table.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0),
                               ("TOPPADDING", (0, 0), (-1, -1), 12), ("BOTTOMPADDING", (0, 0), (-1, -1), 6)]))
    return table


def _themed_table(rows: list[list[str]], shares: list[float]) -> Table:
    data_rows = [[Paragraph(escape(c).upper(), T_TH) for c in rows[0]]] + [[Paragraph(_inline(c), T_TD) for c in r] for r in rows[1:]]
    table = Table(data_rows, colWidths=[WIDTH * share for share in shares], repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), NAVY),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, MIST]),
        ("LINEBELOW", (0, 1), (-1, -1), 0.5, RULE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 9), ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 7), ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ]))
    return table


def _box(flowables: list, background, padding: int = 14) -> Table:
    table = Table([[flowables]], colWidths=[WIDTH])
    table.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), background), ("ROUNDEDCORNERS", [8, 8, 8, 8]),
                               ("LEFTPADDING", (0, 0), (-1, -1), padding + 4), ("RIGHTPADDING", (0, 0), (-1, -1), padding + 4),
                               ("TOPPADDING", (0, 0), (-1, -1), padding), ("BOTTOMPADDING", (0, 0), (-1, -1), padding)]))
    return table


def _figures(items: list[tuple[str, str]], background=None) -> Table:
    table = Table([[[Paragraph(value, T_BIG), Paragraph(escape(label), T_LABEL)] for value, label in items]], colWidths=[WIDTH / len(items)] * len(items))
    style = [("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0 if background is None else 16),
             ("TOPPADDING", (0, 0), (-1, -1), 10), ("BOTTOMPADDING", (0, 0), (-1, -1), 12)]
    style += [("LINEBELOW", (0, 0), (-1, -1), 0.7, RULE)] if background is None else [("BACKGROUND", (0, 0), (-1, -1), background), ("ROUNDEDCORNERS", [8, 8, 8, 8])]
    table.setStyle(TableStyle(style))
    return table


def _path_diagram(chain: dict) -> Drawing:
    """One walked path as boxes and arrows, with the modeled share on each link."""
    names = chain["chain"].split(" -> ")
    roles = ["Supplier"] + ["Buyer and supplier"] * (len(names) - 2) + ["Downstream buyer" if len(names) > 2 else "Buyer"]
    gap = 40
    box_w = (WIDTH - 28 - gap * (len(names) - 1)) / len(names)
    drawing = Drawing(WIDTH - 28, 58)
    for i, (name, role) in enumerate(zip(names, roles)):
        x = i * (box_w + gap)
        drawing.add(Rect(x, 8, box_w, 42, rx=6, ry=6, fillColor=MIST if i == 0 else colors.white, strokeColor=RULE, strokeWidth=1))
        limit = int(box_w / 5.3)
        drawing.add(String(x + 9, 33, name if len(name) <= limit else name[: limit - 1] + "…", fontName="Helvetica-Bold", fontSize=9, fillColor=NAVY))
        drawing.add(String(x + 9, 18, role, fontName="Helvetica", fontSize=7.5, fillColor=GRAY))
        if i < len(names) - 1:
            x0, x1 = x + box_w + 5, x + box_w + gap - 5
            drawing.add(Line(x0, 29, x1 - 4, 29, strokeColor=TEAL, strokeWidth=1.4))
            drawing.add(Polygon([x1, 29, x1 - 6, 32.5, x1 - 6, 25.5], fillColor=TEAL, strokeColor=TEAL))
            drawing.add(String(x0, 37, f"{100 * chain['link_intensities'][i]:.2f}%", fontName="Helvetica", fontSize=7.5, fillColor=GRAY))
    return drawing


def build_snapshot(snapshot: Snapshot) -> bytes:
    facts = _facts(snapshot)
    ev, notes, grants = facts["evaluation"], facts["narratives"], facts["grants"]
    pct = lambda x: f"{100 * x:.1f}%"  # noqa: E731
    count = len(grants)
    word = NUMBER_WORDS[count] if count < len(NUMBER_WORDS) else str(count)
    numbers = iter(range(1, 20))
    stamp = f"Grant memo  |  {date.today():%d %b %Y}  |  Rev. {snapshot.revision}" + ("  |  Draft" if snapshot.needs_update else "")

    def page(canvas, doc):
        width, height = LETTER
        canvas.saveState()
        canvas.setFillColor(TEAL)
        canvas.rect(0, height - 9, width, 9, stroke=0, fill=1)
        canvas.setFont("Helvetica-Bold", 9)
        canvas.setFillColor(NAVY)
        canvas.drawString(inch, height - 42, "CENTRAL MARKET")
        canvas.setFont("Helvetica", 9)
        canvas.setFillColor(GRAY)
        canvas.drawString(inch + 104, height - 42, "/  RELIEF DESK")
        canvas.setFillColor(MIST)
        canvas.roundRect(width - inch - 132, height - 49, 132, 19, 9.5, stroke=0, fill=1)
        canvas.setFillColor(GRAY)
        canvas.setFont("Helvetica-Bold", 7.5)
        canvas.drawString(width - inch - 120, height - 43, "INTERACTIVE GRANT MEMO")
        canvas.setStrokeColor(RULE)
        canvas.line(inch, height - 60, width - inch, height - 60)
        canvas.line(inch, 0.78 * inch, width - inch, 0.78 * inch)
        canvas.setFont("Helvetica", 7.5)
        canvas.drawString(inch, 0.58 * inch, stamp)
        canvas.drawRightString(width - inch, 0.58 * inch, f"Page {doc.page}")
        canvas.restoreState()

    # ---- Part 1: the recommendation ----
    story = [
        Paragraph("01 / FUNDING RECOMMENDATION", T_EYEBROW),
        Paragraph(f"{word} grant{'' if count == 1 else 's'}. One clear case." if count else "No grants selected yet.", T_TITLE),
        Paragraph("Central Market, San Francisco  |  Main Street relief scenario  |  To: economic development officer", T_LEDE),
    ]
    if snapshot.needs_update:
        story.append(_box([Paragraph("<b>DRAFT.</b> The budget or the selected grants changed after some text was written. Review it before presenting.",
                                     ParagraphStyle("d", parent=T_BODY, textColor=AMBER, spaceAfter=0))], AMBER_BG, 9))
        story.append(Spacer(1, 10))
    white = ParagraphStyle("w", parent=T_BODY, textColor=colors.white, spaceAfter=0)
    lead_line = f"Recommend ${ev['total_usd']:,} across {word.lower()} business{'' if count == 1 else 'es'}" if count else "Tick applicants in the report to build a recommendation"
    story.append(_box([
        Paragraph(lead_line, ParagraphStyle("wh", parent=white, fontName="Helvetica-Bold", fontSize=15, leading=19, spaceAfter=5)),
        Paragraph(escape(notes.get("recommendation", "").strip()) or
                  f"The selected grants have a modeled reach of <b>{ev['distinct_businesses_in_reach']} distinct businesses</b>. "
                  "This is network exposure, not a forecast of businesses saved.", white),
    ], NAVY, 16))
    story.append(Spacer(1, 8))
    story.append(_figures([(f"${ev['budget_usd']:,}", "Relief budget"), (f"${ev['total_usd']:,}", "Proposed allocation"),
                           (f"${abs(ev['unallocated_usd']):,}", "Over budget" if ev["over_budget"] else "Unallocated balance")]))

    if grants:
        story.append(_sub(next(numbers), "Proposed allocation"))
        story.append(_themed_table(
            [["Business", "Address", "Proposed", "Own reach", "Newly in reach"]]
            + [[g["name"], g["address"], f"${g['grant_usd']:,}", f"{g['cascade_reach']} businesses", str(g["newly_protected"])] for g in grants],
            [0.31, 0.24, 0.14, 0.17, 0.14]))
        story.append(Spacer(1, 5))
        story.append(Paragraph(f"Reach overlaps across businesses. The union is {ev['distinct_businesses_in_reach']} distinct businesses, so the "
                               "individual counts must not be added up. Applicants and grant amounts are demo inputs.", T_NOTE))
    if facts["others"]:
        block = [_sub(next(numbers), "Why not the others")]
        if notes.get("alternatives"):
            block.append(Paragraph(escape(notes["alternatives"]), T_BODY))
        block.append(_themed_table(
            [["Business", "Reach", "Peers", "Requested", "Why it is not selected"]]
            + [[o["name"], str(o["reach"]), str(o["peers"]), f"${o['requested_usd']:,}", o["why"]] for o in facts["others"]],
            [0.24, 0.09, 0.08, 0.16, 0.43]))
        block.append(Spacer(1, 5))
        block.append(Paragraph("The split is a rule of thumb: most newly reached businesses per dollar, discounted for local substitutes, "
                               "with hubs left out. It is not a proven best answer.", T_NOTE))
        story.extend(block)

    # ---- Part 2: what it protects ----
    if grants:
        lead = grants[0]
        c = lead["cascade"]
        story += [PageBreak(), Paragraph("02 / WHAT IT PROTECTS", T_EYEBROW), Paragraph("See the relationships behind it.", T_TITLE),
                  Paragraph(f"Lead example: {escape(lead['name'])}, {escape(lead['address'])}  |  ${lead['grant_usd']:,} proposed", T_LEDE),
                  _figures([(str(c["exposed_total"]), f"Modeled reach: {c['exposed_by_hops'].get('1_hop', 0)} direct, "
                                                      f"{c['exposed_total'] - c['exposed_by_hops'].get('1_hop', 0)} one step further"),
                            (str(c["exposed_not_in_applicant_queue"]), "Reached businesses outside the demo queue"),
                            (str(c["replaceability"]["same_industry_peers_in_corridor"]), "Same industry peers in the corridor")], MIST)]
        two_hop = next((ch for ch in lead["chains"] if ch["hops"] > 1), lead["chains"][0] if lead["chains"] else None)
        if two_hop:
            caption = ParagraphStyle("cap", fontName="Helvetica-Bold", fontSize=8, leading=11, textColor=TEAL, spaceAfter=6)
            story += [_sub(next(numbers), "A path walked in the graph"),
                      _box([Paragraph("SUPPLY RELATIONSHIP  /  SUPPLIER TO BUYER  /  NOT A GEOGRAPHIC MAP", caption), _path_diagram(two_hop)], MIST, 12),
                      Spacer(1, 5),
                      Paragraph("Percentages are modeled shares of the buyer's input spending, not closure probabilities. "
                                "The path comes from a two step traversal of the BigQuery property graph.", T_NOTE)]
        if notes.get("impact"):
            story.append(Paragraph(escape(notes["impact"]), T_BODY))
        rows = [["Grant", "Chain, supplier to buyer", "Steps", "Share of input spending"]]
        for g in grants:
            for i, ch in enumerate(g["chains"][:4]):
                rows.append([g["name"] if i == 0 else "", _arrow(ch["chain"]), str(ch["hops"]), f"{100 * ch['path_strength']:.2f}%"])
        story += [_sub(next(numbers), "The traversal, grant by grant"), _themed_table(rows, [0.22, 0.52, 0.09, 0.17])]

        sc = facts["scenarios"]
        if sc and "error" not in sc:
            rows = [["If we assume", "Closure risk without a grant", "Grant cuts the risk by", "Businesses shielded", "Cost per business"]]
            for name, row in sc["scenarios"].items():
                cost = f"${row['cost_per_business_shielded_usd']:,}" if row["cost_per_business_shielded_usd"] else "n/a"
                rows.append([name.title(), f"{100 * row['closure_risk_without_grant']:.0f}%", f"{100 * row['risk_cut_by_grant']:.0f}%",
                             f"{row['expected_businesses_shielded']:.1f}", cost])
            block = [_sub(next(numbers), f"What a ${sc['grant_usd']:,} grant changes for {sc['business']}")]
            if notes.get("scenarios"):
                block.append(Paragraph(escape(notes["scenarios"]), T_BODY))
            block += [_themed_table(rows, [0.2, 0.24, 0.2, 0.18, 0.18]), Spacer(1, 5), Paragraph(escape(sc["what_is_assumed"]), T_NOTE)]
            if sc.get("flip_condition"):
                block.append(Paragraph(escape(sc["flip_condition"]), T_NOTE))
            story.append(KeepTogether(block))

    if facts["closing"]:
        r = facts["closing"]
        story.append(KeepTogether([_sub(next(numbers), "Employer closure scenario"),
                                   Paragraph(f"{r['employer_block']['jobs']:,} workers leave census block {r['employer_block']['block_id']}. "
                                             f"{r['first_order_total']} businesses lose modeled worker demand, and {r['second_order_total']} "
                                             "suppliers behind them are exposed.", T_BODY)]))

    # ---- Part 3: evidence ----
    story += [PageBreak(), Paragraph("03 / EVIDENCE AND ASSUMPTIONS", T_EYEBROW), Paragraph("Make the limits easy to inspect.", T_TITLE),
              Paragraph("Public records establish context. Modeled relationships support exploration.", T_LEDE)]
    if ev["audit"]:
        need, bias = ev["audit"]["need"], ev["audit"]["structural_bias_in_the_model"]
        block = [_sub(next(numbers), "Who the neighborhood is")]
        if notes.get("neighborhood"):
            block.append(Paragraph(escape(notes["neighborhood"]), T_BODY))
        block += [
            Table([[
                _bars("Poverty rate", [("Funded tracts", need["funded_avg_tract_poverty"], pct(need["funded_avg_tract_poverty"]), TEAL),
                                       ("Corridor", need["corridor_avg_tract_poverty"], pct(need["corridor_avg_tract_poverty"]), GRAY)]),
                _bars("Households with no vehicle", [("Funded tracts", need["funded_avg_no_vehicle"], pct(need["funded_avg_no_vehicle"]), TEAL),
                                                     ("Corridor", need["corridor_avg_no_vehicle"], pct(need["corridor_avg_no_vehicle"]), GRAY)]),
            ]], colWidths=[WIDTH / 2] * 2),
            Spacer(1, 6),
            Paragraph(f"A bias in the model: food service is {pct(bias['food_service_share_of_all_businesses'])} of businesses but "
                      f"{pct(bias['food_service_share_of_businesses_with_a_cascade'])} of businesses with any modeled cascade. "
                      "A business with no modeled links is unseen by the model, not unimportant.", T_BODY),
        ]
        story.append(KeepTogether(block))
    health = analysis.data_health_check()
    story.append(KeepTogether([
        _sub(next(numbers), "What supports this memo"),
        _themed_table([
            ["Evidence type", "Input", "What it tells us"],
            ["Public record", f"SF business registry: {health['businesses']} corridor businesses", "Identity, industry and location"],
            ["Public record", "Census ACS tracts and LEHD workplace blocks", "Neighborhood context and workplace job counts"],
            ["Public record", f"{health['sba_loans']} matched SBA loans, {health['sba_loans_charged_off']} charged off", "Too few to test the model against real outcomes"],
            ["Modeled estimate", f"{health['supply_edges']:,} supply links, {health['footfall_edges']:,} worker demand links", "Possible dependencies, not verified invoices or visits"],
            ["Demo input", f"{len(APPLICANTS)} applicants, ${sum(a['requested_usd'] for a in APPLICANTS):,} requested", "A sample decision scenario, not real applications"],
        ], [0.2, 0.42, 0.38]),
        Spacer(1, 5),
        Paragraph("Checks run on the tables: link keys are unique, no link points at a missing business, and no business supplies itself."
                  if health["passed"] else "Checks on the tables found problems. Review the data before relying on this memo.", T_NOTE),
    ]))
    if snapshot.notes_markdown.strip():
        story.append(_sub(next(numbers), "Advisor memo"))
        story.extend(_body(snapshot.notes_markdown))
    story.append(Spacer(1, 10))
    amber_title = ParagraphStyle("at", fontName="Helvetica-Bold", fontSize=8.5, leading=12, textColor=AMBER, spaceAfter=5)
    story.append(KeepTogether([_box([
        Paragraph("REVIEW BEFORE APPROVAL", amber_title),
        Paragraph("Confirm the supplier relationships, the financial distress and how a grant would help. Reach counts modeled links. "
                  "It is not a count of businesses saved, and no jobs figure is supported. There is no revenue, rent or distress data. "
                  "A grant changes a probability, not an outcome.", ParagraphStyle("ab", parent=T_BODY, spaceAfter=0)),
    ], AMBER_BG, 13)]))
    story.append(Spacer(1, 10))
    story.append(Paragraph("<b>SOURCES.</b> City of San Francisco registered business locations. Census ACS and LEHD. SBA 7(a) loan records. "
                           "BEA input output purchase rates for the modeled supply links. Race and ethnicity are never inputs.", T_NOTE))

    buffer = io.BytesIO()
    SimpleDocTemplate(buffer, pagesize=LETTER, leftMargin=inch, rightMargin=inch, topMargin=1.05 * inch, bottomMargin=1.0 * inch,
                      title=snapshot.title, author="Central Market relief desk").build(story, onFirstPage=page, onLaterPages=page)
    return buffer.getvalue()


@router.post("/api/report")
def report(request: ReportRequest) -> Response:
    if request.snapshot is not None:
        name = f"grant-memo-revision-{request.snapshot.revision}"
        if request.format == "md":
            return Response(markdown_for(request.snapshot), media_type="text/markdown; charset=utf-8",
                            headers={"Content-Disposition": f'attachment; filename="{name}.md"'})
        return Response(build_snapshot(request.snapshot), media_type="application/pdf",
                        headers={"Content-Disposition": f'attachment; filename="{name}.pdf"'})
    pdf = build(request.markdown[:60_000], request.question)
    return Response(pdf, media_type="application/pdf", headers={"Content-Disposition": 'attachment; filename="grant-memo.pdf"'})
