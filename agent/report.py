"""Turns an advisor answer into a PDF grant memo with a few plain charts."""

import io
import re
from datetime import date
from html import escape

from fastapi import APIRouter
from fastapi.responses import Response
from pydantic import BaseModel
from reportlab.graphics.shapes import Drawing, Rect, String
from reportlab.lib import colors
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from microgrants import analysis, data, tools

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


def _bars(title: str, rows: list[tuple[str, float, str, colors.Color]], width: float = WIDTH / 2 - 8, value_w: int = 44) -> Drawing:
    """Horizontal bars with the value written at the end of each one."""
    height = 22 + 20 * len(rows)
    drawing = Drawing(width, height)
    drawing.add(String(0, height - 11, title, fontName="Helvetica-Bold", fontSize=9, fillColor=INK))
    top = max(value for _, value, _, _ in rows) or 1
    label_w = 100
    for i, (label, value, shown, color) in enumerate(rows):
        y = height - 36 - 20 * i
        drawing.add(String(0, y + 3, label[:20], fontName="Helvetica", fontSize=8.5, fillColor=SOFT))
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
    subject = data.directory().get(snapshot.subject_id)
    closing = None
    if snapshot.employer_block_id:
        from microgrants import closure

        result = closure.simulate_employer_closure(snapshot.employer_block_id)
        closing = None if "error" in result else result
    return {"evaluation": evaluation, "subject": subject, "closing": closing}


def markdown_for(snapshot: Snapshot) -> str:
    facts = _facts(snapshot)
    ev = facts["evaluation"]
    lines = [
        f"# {snapshot.title}",
        "",
        f"Interactive Grant Memo, revision {snapshot.revision}, {date.today():%B %d, %Y}."
        + (" Draft: some sections need an update." if snapshot.needs_update else ""),
        "",
        "## 1. Recommendation",
        "",
        f"- Budget: ${ev['budget_usd']:,}",
        f"- Proposed: ${ev['total_usd']:,} across {len(ev['grants'])} grants",
        f"- Unallocated: ${ev['unallocated_usd']:,}" + (" (over budget)" if ev["over_budget"] else ""),
        f"- Distinct businesses in modeled reach: {ev['distinct_businesses_in_reach']}",
        "",
    ]
    if snapshot.narrative.strip():
        lines += [snapshot.narrative.strip(), ""]
    if ev["grants"]:
        lines += ["| Business | Role | Proposed grant | Newly in modeled reach | Tract poverty |", "|---|---|---|---|---|"]
        lines += [
            f"| {g['name']} | {g['network_role']} | ${g['grant_usd']:,} | {g['newly_protected']} | {100 * g['tract_poverty_rate']:.1f}% |"
            for g in ev["grants"]
        ]
        lines.append("")
    else:
        lines += ["No grants are selected in this revision.", ""]
    if facts["subject"]:
        c = tools.trace_cascade(facts["subject"]["business_id"])
        lines += [
            f"## 2. What is exposed: {facts['subject']['name']}", "",
            f"- {c['exposed_total']} businesses in modeled reach within two steps ({c['exposed_by_hops'].get('1_hop', 0)} direct)",
            f"- {c['exposed_not_in_applicant_queue']} of them are outside the demo applicant queue",
            f"- Same industry peers in the corridor: {c['replaceability']['same_industry_peers_in_corridor']}. Outside corridor alternatives are unknown.",
            "", "Strongest chains:", "",
        ]
        lines += [f"- {ch['chain']} ({100 * ch['path_strength']:.2f}% of buyer input spending)" for ch in c["strongest_chains"][:6]]
        lines.append("")
    if facts["closing"]:
        r = facts["closing"]
        lines += [
            f"## Employer closure: block {r['employer_block']['block_id']}", "",
            f"- {r['employer_block']['jobs']:,} workers leave",
            f"- {r['first_order_total']} businesses lose modeled worker demand",
            f"- {r['second_order_total']} suppliers behind them are exposed", "",
        ]
    if ev["audit"]:
        need = ev["audit"]["need"]
        bias = ev["audit"]["structural_bias_in_the_model"]
        lines += [
            "## 3. Neighborhood impact", "",
            f"- Funded tracts average {100 * need['funded_avg_tract_poverty']:.1f}% poverty, against {100 * need['corridor_avg_tract_poverty']:.1f}% for the corridor.",
            f"- Food service is {100 * bias['food_service_share_of_all_businesses']:.1f}% of businesses but "
            f"{100 * bias['food_service_share_of_businesses_with_a_cascade']:.1f}% of businesses with any modeled cascade.", "",
        ]
    if snapshot.notes_markdown.strip():
        lines += ["## Advisor memo", "", snapshot.notes_markdown.split("<follow_ups>")[0].strip(), ""]
    lines += ["## Evidence and limitations", ""] + [f"- {item}" for item in LIMITS]
    return "\n".join(lines) + "\n"


def build_snapshot(snapshot: Snapshot) -> bytes:
    facts = _facts(snapshot)
    ev = facts["evaluation"]
    story = [
        Paragraph(escape(snapshot.title), H1),
        Paragraph(f"Interactive Grant Memo &nbsp;&nbsp; Revision {snapshot.revision} &nbsp;&nbsp; {date.today():%B %d, %Y} &nbsp;&nbsp; "
                  "To: Economic development officer, Central Market relief fund", SMALL),
    ]
    if snapshot.needs_update:
        story.append(Paragraph("<b>Draft.</b> The inputs changed after some text was written. Review before presenting.", SMALL))
    story.append(Table([[""]], colWidths=[WIDTH], rowHeights=[4], style=TableStyle([("LINEBELOW", (0, 0), (-1, -1), 1.2, INK)])))
    story.append(Spacer(1, 8))

    story.append(Paragraph("1. Recommendation", H2))
    number = ParagraphStyle("n2", parent=BODY, fontName="Helvetica-Bold", fontSize=16, leading=19, spaceAfter=0)
    stats = [(f"${ev['budget_usd']:,}", "budget"), (f"${ev['total_usd']:,}", "proposed"),
             (f"${ev['unallocated_usd']:,}", "over budget" if ev["over_budget"] else "unallocated"),
             (str(ev["distinct_businesses_in_reach"]), "businesses in modeled reach")]
    boxes = Table([[[Paragraph(n, number), Paragraph(label, SMALL)] for n, label in stats]], colWidths=[WIDTH / 4] * 4)
    boxes.setStyle(TableStyle([("BOX", (0, 0), (-1, -1), 0.5, LINE), ("INNERGRID", (0, 0), (-1, -1), 0.5, LINE),
                               ("LEFTPADDING", (0, 0), (-1, -1), 8), ("TOPPADDING", (0, 0), (-1, -1), 7), ("BOTTOMPADDING", (0, 0), (-1, -1), 7)]))
    story += [boxes, Spacer(1, 8)]
    if snapshot.narrative.strip():
        story += _body(snapshot.narrative)
    if ev["grants"]:
        story.append(_table([["Business", "Role", "Proposed grant", "Newly in reach", "Tract poverty"]] + [
            [g["name"], g["network_role"], f"${g['grant_usd']:,}", str(g["newly_protected"]), f"{100 * g['tract_poverty_rate']:.1f}%"]
            for g in ev["grants"]
        ]))
        story.append(Spacer(1, 8))
        story.append(_bars("Businesses newly in modeled reach, per grant",
                           [(g["name"], g["newly_protected"], f"{g['newly_protected']}  (${g['grant_usd']:,})", SAFE) for g in ev["grants"]], WIDTH, 84))
        story.append(Paragraph("Demo applicants and requested amounts. Reach is not a count of businesses saved.", SMALL))
    else:
        story.append(Paragraph("No grants are selected in this revision.", BODY))

    if facts["subject"]:
        story.extend(_at_a_glance(facts["subject"]))
    if facts["closing"]:
        r = facts["closing"]
        story += [Paragraph("Employer closure scenario", H2),
                  Paragraph(f"{r['employer_block']['jobs']:,} workers leave census block {r['employer_block']['block_id']}. "
                            f"{r['first_order_total']} businesses lose modeled worker demand, and {r['second_order_total']} "
                            "suppliers behind them are exposed.", BODY)]
    if ev["audit"]:
        need = ev["audit"]["need"]
        bias = ev["audit"]["structural_bias_in_the_model"]
        pct = lambda x: f"{100 * x:.1f}%"  # noqa: E731
        story += [
            Paragraph("Neighborhood impact", H2),
            Table([[
                _bars("Poverty rate", [("Funded tracts", need["funded_avg_tract_poverty"], pct(need["funded_avg_tract_poverty"]), ACCENT),
                                       ("Corridor", need["corridor_avg_tract_poverty"], pct(need["corridor_avg_tract_poverty"]), SOFT)]),
                _bars("Food service share (model bias)", [
                    ("With a cascade", bias["food_service_share_of_businesses_with_a_cascade"], pct(bias["food_service_share_of_businesses_with_a_cascade"]), ACCENT),
                    ("All businesses", bias["food_service_share_of_all_businesses"], pct(bias["food_service_share_of_all_businesses"]), SOFT)]),
            ]], colWidths=[WIDTH / 2] * 2),
        ]
    if snapshot.notes_markdown.strip():
        story.append(Paragraph("Advisor memo", H2))
        story.extend(_body(snapshot.notes_markdown))
    story.append(Paragraph("Evidence and limitations", H2))
    story.extend(Paragraph(_inline(item), BULLET, bulletText="•") for item in LIMITS)

    buffer = io.BytesIO()
    SimpleDocTemplate(buffer, pagesize=LETTER, leftMargin=inch, rightMargin=inch, topMargin=0.8 * inch, bottomMargin=0.9 * inch,
                      title=snapshot.title, author="Central Market relief desk").build(story, onFirstPage=_footer, onLaterPages=_footer)
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
