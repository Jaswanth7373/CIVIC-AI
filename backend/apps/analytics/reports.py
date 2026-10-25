"""Report datasets and exports for ``/api/analytics/reports/`` (owner B5).

A report is a *dataset* (summary, complaints, departments, officers, feedback) built from the
database for the requested filters, then rendered as

* a **JSON preview** ``{"report", "title", "generated_at", "filters", "columns", "rows", "summary"}``,
* a **CSV** file (Python ``csv`` module, UTF-8 with a byte-order mark so Excel detects the
  encoding; cells that start with ``= + - @`` are prefixed with an apostrophe to prevent
  spreadsheet formula injection), or
* a **PDF** (ReportLab platypus: A4 landscape, title "CivicAI - <Report name>", generation time,
  filters, a key-figures table and the data table whose header row repeats on every page,
  with "Page X of Y" footers drawn by a two-pass canvas).

Downloads are named like ``civicai-complaints-2026-10-17.csv`` and audit-logged by the view.
"""
import csv
import functools
import io
import logging
import os
from dataclasses import dataclass
from datetime import datetime
from xml.sax.saxutils import escape

from django.utils import timezone

from apps.complaints.models import Complaint
from apps.feedback.models import Feedback

from . import services
from .serializers import LEVEL_LABELS, STATUS_LABELS, iso, local_today, local_tz

logger = logging.getLogger("apps.analytics")

EXPORT_ROW_LIMITS = {"csv": 50000, "pdf": 1500}
SENTIMENT_LABELS = dict(Feedback.Sentiment.choices)


@dataclass(frozen=True)
class Column:
    """A report column: ``key`` in each row, header ``label``, relative PDF ``width``, alignment."""

    key: str
    label: str
    width: float = 1.0
    align: str = "LEFT"


@dataclass
class Report:
    key: str
    name: str
    filters: object
    columns: list
    rows: list
    total_rows: int
    summary: list  # [(key, label, value)] key figures
    generated_at: datetime

    @property
    def title(self):
        return f"CivicAI - {self.name}"

    @property
    def truncated(self):
        return len(self.rows) < self.total_rows


def _officer_name(first, last, email):
    name = f"{first or ''} {last or ''}".strip()
    return name or ((email or "").split("@")[0])


# ---------------------------------------------------------------------------------------------
# Datasets: each returns (columns, rows, total_rows, summary)
# ---------------------------------------------------------------------------------------------
def _summary_dataset(filters, limit):
    data = services.overview(filters, include_lists=False)
    totals = data["totals"]
    rows = []

    def add(section, metric, value):
        rows.append({"section": section, "metric": metric, "value": value})

    add("Complaints", "Total complaints", totals["total"])
    add("Complaints", "Pending", totals["pending"])
    add("Complaints", "In progress", totals["in_progress"])
    add("Complaints", "Resolved / verified / closed", totals["resolved"])
    add("Complaints", "Rejected", totals["rejected"])
    add("Complaints", "Open critical priority", totals["critical"])
    add("Complaints", "Open and past SLA", totals["overdue"])
    add("Complaints", "Reopened at least once", totals["reopened"])
    add("Complaints", "Duplicate pairs awaiting review", totals["duplicates_pending"])
    add("Complaints", "Open and flagged for manual review", totals["needs_review"])
    add("Performance", "Average resolution time (hours)", data["avg_resolution_hours"])
    add("Performance", "SLA compliance (%)", data["sla_compliance"])
    add("Feedback", "Feedback received", data["feedback_count"])
    add("Feedback", "Average rating (1-5)", data["avg_rating"])
    add("Feedback", "Satisfaction rate (% rated 4-5)", data["satisfaction_rate"])
    for item in data["status_distribution"]:
        add("Status", item["label"], item["count"])
    for item in data["severity_distribution"]:
        add("Severity", item["label"], item["count"])
    for item in data["priority_distribution"]:
        add("Priority level", item["label"], item["count"])
    for item in services.category_breakdown(filters):
        add("Category", item["category"]["name"], item["total"])
    for item in services.department_breakdown(filters):
        add("Department", item["department"]["name"], item["total"])
    columns = [
        Column("section", "Section", 1.2), Column("metric", "Metric", 3.0), Column("value", "Value", 1.0, "RIGHT"),
    ]
    summary = [
        ("total_complaints", "Total complaints", totals["total"]),
        ("resolved", "Resolved", totals["resolved"]),
        ("avg_resolution_hours", "Avg resolution (h)", data["avg_resolution_hours"]),
        ("sla_compliance", "SLA compliance (%)", data["sla_compliance"]),
        ("avg_rating", "Average rating", data["avg_rating"]),
        ("satisfaction_rate", "Satisfaction (%)", data["satisfaction_rate"]),
    ]
    return columns, rows[:limit], len(rows), summary


COMPLAINT_COLUMNS = [
    Column("complaint_number", "Complaint No.", 1.3),
    Column("submitted", "Submitted", 1.2),
    Column("title", "Title", 2.6),
    Column("category", "Category", 1.4),
    Column("department", "Department", 1.4),
    Column("status", "Status", 0.95),
    Column("severity", "Severity", 0.8),
    Column("priority_score", "Priority", 0.7, "RIGHT"),
    Column("priority_level", "Priority level", 0.85),
    Column("area", "Area", 1.2),
    Column("officer", "Assigned officer", 1.3),
    Column("resolved", "Resolved", 1.2),
    Column("resolution_hours", "Resolution (h)", 0.85, "RIGHT"),
    Column("sla_due", "SLA due", 1.2),
    Column("overdue", "Overdue", 0.7),
]


def _complaints_dataset(filters, limit):
    now = timezone.now()
    complaints = Complaint.objects.filter(filters.complaint_q())
    values = complaints.order_by("-created_at", "-id").values(
        "complaint_number", "created_at", "title", "category__name", "department__name", "status", "severity",
        "priority_score", "priority_level", "location__area", "assigned_officer__first_name",
        "assigned_officer__last_name", "assigned_officer__email", "resolved_at", "sla_due_at",
    )[:limit]
    rows = []
    for item in values:
        resolved = item["resolved_at"] if item["status"] in services.RESOLVED else None
        hours = round((resolved - item["created_at"]).total_seconds() / 3600, 1) if resolved else None
        rows.append({
            "complaint_number": item["complaint_number"],
            "submitted": item["created_at"],
            "title": item["title"],
            "category": item["category__name"] or "",
            "department": item["department__name"] or "",
            "status": STATUS_LABELS.get(item["status"], item["status"]),
            "severity": LEVEL_LABELS.get(item["severity"], ""),
            "priority_score": item["priority_score"],
            "priority_level": LEVEL_LABELS.get(item["priority_level"], ""),
            "area": item["location__area"] or "",
            "officer": _officer_name(item["assigned_officer__first_name"], item["assigned_officer__last_name"],
                                     item["assigned_officer__email"]),
            "resolved": resolved,
            "resolution_hours": max(hours, 0.0) if hours is not None else None,
            "sla_due": item["sla_due_at"],
            "overdue": bool(item["status"] in services.OPEN and item["sla_due_at"] and item["sla_due_at"] < now),
        })
    figures = services.key_figures(complaints)
    summary = [
        ("total_complaints", "Complaints", figures["total"]),
        ("open", "Open", figures["open"]),
        ("resolved", "Resolved", figures["resolved"]),
        ("overdue", "Open past SLA", figures["overdue"]),
        ("avg_resolution_hours", "Avg resolution (h)", figures["avg_resolution_hours"]),
        ("sla_compliance", "SLA compliance (%)", figures["sla_compliance"]),
    ]
    return COMPLAINT_COLUMNS, rows, figures["total"], summary


DEPARTMENT_COLUMNS = [
    Column("department", "Department", 2.0),
    Column("code", "Code", 0.8),
    Column("total", "Total", 0.7, "RIGHT"),
    Column("pending", "Pending", 0.8, "RIGHT"),
    Column("in_progress", "In progress", 0.9, "RIGHT"),
    Column("resolved", "Resolved", 0.8, "RIGHT"),
    Column("critical", "Critical (open)", 0.9, "RIGHT"),
    Column("overdue", "Overdue", 0.8, "RIGHT"),
    Column("avg_resolution_hours", "Avg resolution (h)", 1.0, "RIGHT"),
    Column("resolution_rate", "Resolution rate (%)", 1.0, "RIGHT"),
    Column("sla_compliance", "SLA compliance (%)", 1.0, "RIGHT"),
    Column("avg_rating", "Avg rating", 0.8, "RIGHT"),
    Column("officer_count", "Officers", 0.8, "RIGHT"),
    Column("active_workload", "Active workload", 0.9, "RIGHT"),
]


def _departments_dataset(filters, limit):
    breakdown = services.department_breakdown(filters)
    rows = []
    for item in breakdown:
        row = {column.key: item.get(column.key) for column in DEPARTMENT_COLUMNS[2:]}
        row.update({"department": item["department"]["name"], "code": item["department"]["code"]})
        rows.append(row)
    figures = services.key_figures(Complaint.objects.filter(filters.complaint_q(), department__isnull=False))
    summary = [
        ("departments", "Departments", len(rows)),
        ("total_complaints", "Routed complaints", figures["total"]),
        ("resolved", "Resolved", figures["resolved"]),
        ("avg_resolution_hours", "Avg resolution (h)", figures["avg_resolution_hours"]),
        ("sla_compliance", "SLA compliance (%)", figures["sla_compliance"]),
    ]
    return DEPARTMENT_COLUMNS, rows[:limit], len(rows), summary


OFFICER_COLUMNS = [
    Column("officer", "Officer", 1.8),
    Column("employee_id", "Employee ID", 1.0),
    Column("department", "Department", 1.8),
    Column("active", "Active", 0.7, "RIGHT"),
    Column("capacity", "Capacity", 0.8, "RIGHT"),
    Column("utilization", "Utilization (%)", 1.0, "RIGHT"),
    Column("overloaded", "Overloaded", 0.8),
    Column("is_available", "Available", 0.8),
    Column("resolved_total", "Resolved", 0.8, "RIGHT"),
    Column("resolved_30d", "Resolved (30 days)", 1.0, "RIGHT"),
    Column("avg_resolution_hours", "Avg resolution (h)", 1.0, "RIGHT"),
    Column("avg_rating", "Avg rating", 0.8, "RIGHT"),
    Column("critical_active", "Critical active", 0.9, "RIGHT"),
]


def _officers_dataset(filters, limit):
    performance = services.officer_performance(filters)
    rows = []
    for item in performance:
        rows.append({
            "officer": item["officer"]["full_name"],
            "employee_id": item["officer"].get("employee_id", ""),
            "department": item["department"]["name"] if item["department"] else "",
            "active": item["active"],
            "capacity": item["capacity"],
            "utilization": round(item["utilization"] * 100, 1),
            "overloaded": item["overloaded"],
            "is_available": item["is_available"],
            "resolved_total": item["resolved_total"],
            "resolved_30d": item["resolved_30d"],
            "avg_resolution_hours": item["avg_resolution_hours"],
            "avg_rating": item["avg_rating"],
            "critical_active": item["critical_active"],
        })
    from apps.assignments.services import workload_figures

    capacity = sum(item["capacity"] for item in performance)
    active = sum(item["active"] for item in performance)
    overall = workload_figures(active, capacity)["utilization"] if performance else 0.0
    summary = [
        ("officers", "Officers", len(rows)),
        ("available", "Available", sum(1 for item in performance if item["is_available"])),
        ("active_complaints", "Active complaints", active),
        ("utilization", "Overall utilization (%)", round(100 * overall, 1)),
        ("overloaded", "Overloaded officers", sum(1 for item in performance if item["overloaded"])),
        ("resolved_30d", "Resolved (30 days)", sum(item["resolved_30d"] for item in performance)),
    ]
    return OFFICER_COLUMNS, rows[:limit], len(rows), summary


FEEDBACK_COLUMNS = [
    Column("date", "Date", 1.1),
    Column("complaint_number", "Complaint No.", 1.2),
    Column("department", "Department", 1.4),
    Column("category", "Category", 1.4),
    Column("rating", "Rating", 0.6, "RIGHT"),
    Column("sentiment", "Sentiment", 0.8),
    Column("sentiment_score", "Score", 0.6, "RIGHT"),
    Column("text", "Feedback", 4.5),
]


def _feedback_dataset(filters, limit):
    feedback = services.filtered_feedback(filters)
    total = feedback.count()
    values = feedback.order_by("-created_at", "-id").values(
        "created_at", "complaint__complaint_number", "complaint__department__name", "complaint__category__name",
        "rating", "sentiment", "sentiment_score", "text",
    )[:limit]
    rows = [
        {
            "date": item["created_at"],
            "complaint_number": item["complaint__complaint_number"],
            "department": item["complaint__department__name"] or "",
            "category": item["complaint__category__name"] or "",
            "rating": item["rating"],
            "sentiment": SENTIMENT_LABELS.get(item["sentiment"], ""),
            "sentiment_score": round(item["sentiment_score"], 2),
            "text": item["text"],
        }
        for item in values
    ]
    sentiment = services.feedback_figures(feedback)
    summary = [
        ("total_feedback", "Feedback", total),
        ("average_rating", "Average rating", sentiment["average_rating"]),
        ("satisfaction_rate", "Satisfaction (%)", sentiment["satisfaction_rate"]),
        ("positive_pct", "Positive (%)", sentiment["positive_pct"]),
        ("neutral_pct", "Neutral (%)", sentiment["neutral_pct"]),
        ("negative_pct", "Negative (%)", sentiment["negative_pct"]),
    ]
    return FEEDBACK_COLUMNS, rows, total, summary


REPORTS = {
    "summary": ("Summary report", _summary_dataset),
    "complaints": ("Complaints report", _complaints_dataset),
    "departments": ("Department performance report", _departments_dataset),
    "officers": ("Officer performance report", _officers_dataset),
    "feedback": ("Citizen feedback report", _feedback_dataset),
}


def build_report(key, filters, *, limit):
    """Build the dataset ``key`` for ``filters`` with at most ``limit`` rows."""
    name, builder = REPORTS[key]
    columns, rows, total, summary = builder(filters, limit)
    return Report(key=key, name=name, filters=filters, columns=list(columns), rows=rows, total_rows=total,
                  summary=summary, generated_at=timezone.now())


def report_preview(report):
    """JSON preview payload for the frontend's report page."""
    return {
        "report": report.key,
        "title": report.title,
        "generated_at": iso(report.generated_at),
        "filters": report.filters.as_dict(),
        "columns": [{"key": column.key, "label": column.label} for column in report.columns],
        "rows": report.rows,
        "summary": {key: value for key, _, value in report.summary},
        "summary_items": [{"key": key, "label": label, "value": value} for key, label, value in report.summary],
        "total_rows": report.total_rows,
        "truncated": report.truncated,
    }


def report_filename(key, extension):
    """``civicai-<report>-<local date>.<ext>``, e.g. ``civicai-complaints-2026-10-17.csv``."""
    return f"civicai-{key}-{local_today().isoformat()}.{extension}"


# ---------------------------------------------------------------------------------------------
# Cell formatting
# ---------------------------------------------------------------------------------------------
_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


def _format_cell(value):
    """Human-readable text for CSV / PDF cells (local times, Yes/No, plain numbers)."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "Yes" if value else "No"
    if isinstance(value, datetime):
        return value.astimezone(local_tz()).strftime("%Y-%m-%d %H:%M")
    if isinstance(value, float):
        return f"{value:.2f}".rstrip("0").rstrip(".")  # 72.40 -> "72.4", 50.00 -> "50"
    return str(value)


def _csv_cell(value):
    text = _format_cell(value)
    if isinstance(value, str) and text.startswith(_FORMULA_PREFIXES):
        return "'" + text  # neutralise spreadsheet formula injection in user-written text
    return text


def render_csv(report):
    """CSV bytes: UTF-8 with BOM, header row of column labels, one line per row."""
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow([column.label for column in report.columns])
    for row in report.rows:
        writer.writerow([_csv_cell(row.get(column.key)) for column in report.columns])
    return ("\ufeff" + buffer.getvalue()).encode("utf-8")


# ---------------------------------------------------------------------------------------------
# PDF (ReportLab)
# ---------------------------------------------------------------------------------------------
def _font_candidates():
    windows_fonts = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts")
    return [
        ("DejaVuSans", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
         "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
        ("Arial", os.path.join(windows_fonts, "arial.ttf"), os.path.join(windows_fonts, "arialbd.ttf")),
        ("Arial", "/Library/Fonts/Arial.ttf", "/Library/Fonts/Arial Bold.ttf"),
    ]


@functools.lru_cache(maxsize=1)
def pdf_fonts():
    """(regular, bold) font names: a Unicode TrueType font when the OS has one, else Helvetica.

    TrueType fonts render characters outside Latin-1 (e.g. the rupee sign) that the built-in
    PDF base fonts cannot; ReportLab embeds only the glyph subset that is used.
    """
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont

    for family, regular, bold in _font_candidates():
        if os.path.exists(regular) and os.path.exists(bold):
            try:
                pdfmetrics.registerFont(TTFont(f"CivicAI-{family}", regular))
                pdfmetrics.registerFont(TTFont(f"CivicAI-{family}-Bold", bold))
                return f"CivicAI-{family}", f"CivicAI-{family}-Bold"
            except Exception:
                logger.warning("Could not register PDF font %s; trying the next one.", regular, exc_info=True)
    return "Helvetica", "Helvetica-Bold"


def _numbered_canvas(footer_text, font_name, margin):
    """Canvas class that writes "Page X of Y" footers.

    Two-pass technique: ``showPage`` only stores each finished page's state; ``save`` knows the
    total page count and replays every page, drawing the footer before emitting it.
    """
    from reportlab.lib import colors
    from reportlab.lib.units import mm
    from reportlab.pdfgen import canvas

    class NumberedCanvas(canvas.Canvas):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self._page_states = []

        def showPage(self):
            self._page_states.append(dict(self.__dict__))
            self._startPage()

        def save(self):
            total = len(self._page_states)
            for state in self._page_states:
                self.__dict__.update(state)
                self._draw_footer(total)
                super().showPage()
            super().save()

        def _draw_footer(self, total):
            width = self._pagesize[0]
            self.saveState()
            self.setFont(font_name, 7.5)
            self.setFillColor(colors.HexColor("#5B6770"))
            self.drawString(margin, 8 * mm, footer_text)
            self.drawRightString(width - margin, 8 * mm, f"Page {self._pageNumber} of {total}")
            self.restoreState()

    return NumberedCanvas


def render_pdf(report):
    """PDF bytes for ``report`` (A4 landscape)."""
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_RIGHT
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.platypus import LongTable, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    regular, bold = pdf_fonts()
    green, line, zebra, ink_2 = (colors.HexColor(code) for code in ("#0B6E4F", "#C9D1CC", "#F2F5F3", "#4A5760"))
    styles = {
        "title": ParagraphStyle("title", fontName=bold, fontSize=17, leading=21, spaceAfter=2),
        "meta": ParagraphStyle("meta", fontName=regular, fontSize=8.5, leading=11, textColor=ink_2),
        "heading": ParagraphStyle("heading", fontName=bold, fontSize=11, leading=14, spaceBefore=4, spaceAfter=4),
        "note": ParagraphStyle("note", fontName=regular, fontSize=8, leading=10, textColor=ink_2, spaceAfter=4),
        "th": ParagraphStyle("th", fontName=bold, fontSize=7, leading=8.5, textColor=colors.white),
        "td": ParagraphStyle("td", fontName=regular, fontSize=7, leading=8.5),
        "td_right": ParagraphStyle("td_right", fontName=regular, fontSize=7, leading=8.5, alignment=TA_RIGHT),
        "kf_label": ParagraphStyle("kf_label", fontName=regular, fontSize=8, leading=10, textColor=ink_2),
        "kf_value": ParagraphStyle("kf_value", fontName=bold, fontSize=12, leading=14),
    }
    margin = 14 * mm
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(
        buffer, pagesize=landscape(A4), leftMargin=margin, rightMargin=margin, topMargin=margin,
        bottomMargin=16 * mm, title=report.title, author="CivicAI", subject=report.name,
        creator="CivicAI analytics",
    )
    generated = report.generated_at.astimezone(local_tz())
    generated_text = f"{generated:%d %b %Y, %H:%M} {generated.tzname()}"
    filters = report.filters.describe()
    filters_text = "; ".join(f"{label}: {value}" for label, value in filters) if filters else "none (all records)"

    story = [
        Paragraph(escape(report.title), styles["title"]),
        Paragraph(f"Generated {escape(generated_text)}", styles["meta"]),
        Paragraph(f"Filters: {escape(filters_text)}", styles["meta"]),
        Spacer(1, 5 * mm),
    ]
    if report.summary:
        cells = [
            [Paragraph(escape(label), styles["kf_label"]), Paragraph(escape(_format_cell(value)), styles["kf_value"])]
            for _, label, value in report.summary
        ]
        per_row = 3
        grid = []
        for start in range(0, len(cells), per_row):
            chunk = [part for pair in cells[start:start + per_row] for part in pair]
            grid.append(chunk + [""] * (2 * per_row - len(chunk)))
        label_width, value_width = doc.width * 0.2, doc.width * (1 / per_row - 0.2)
        figures = Table(grid, colWidths=[label_width, value_width] * per_row, hAlign="LEFT")
        figures.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("BOX", (0, 0), (-1, -1), 0.5, line),
            ("INNERGRID", (0, 0), (-1, -1), 0.25, line),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ]))
        story += [Paragraph("Key figures", styles["heading"]), figures, Spacer(1, 5 * mm)]

    story.append(Paragraph(f"Data ({report.total_rows:,} rows)", styles["heading"]))
    if report.truncated:
        story.append(Paragraph(
            f"Showing the first {len(report.rows):,} of {report.total_rows:,} rows. "
            "Download the CSV export for the complete dataset.", styles["note"],
        ))
    weights = [column.width for column in report.columns]
    widths = [doc.width * weight / sum(weights) for weight in weights]
    header = [Paragraph(escape(column.label), styles["th"]) for column in report.columns]
    body = [
        [
            Paragraph(escape(_format_cell(row.get(column.key))),
                      styles["td_right"] if column.align == "RIGHT" else styles["td"])
            for column in report.columns
        ]
        for row in report.rows
    ]
    table_style = [
        ("BACKGROUND", (0, 0), (-1, 0), green),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("GRID", (0, 0), (-1, -1), 0.25, line),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, zebra]),
        ("TOPPADDING", (0, 0), (-1, -1), 2.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5),
        ("LEFTPADDING", (0, 0), (-1, -1), 3),
        ("RIGHTPADDING", (0, 0), (-1, -1), 3),
    ]
    if not body:
        body = [[Paragraph("No records match the selected filters.", styles["td"])] + [""] * (len(widths) - 1)]
        table_style.append(("SPAN", (0, 1), (-1, 1)))
    data_table = LongTable([header] + body, colWidths=widths, repeatRows=1)
    data_table.setStyle(TableStyle(table_style))
    story.append(data_table)

    doc.build(story, canvasmaker=_numbered_canvas(f"{report.title} - generated {generated_text}", regular, margin))
    return buffer.getvalue()
