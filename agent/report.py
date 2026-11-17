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


class ReportRequest(BaseModel):
    markdown: str
    question: str = ""


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


@router.post("/api/report")
def report(request: ReportRequest) -> Response:
    pdf = build(request.markdown[:60_000], request.question)
    return Response(pdf, media_type="application/pdf", headers={"Content-Disposition": 'attachment; filename="grant-memo.pdf"'})
