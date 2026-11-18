"""Draft e-FIR: pre-filled from the ID record, itinerary, track and alert log for an officer to REVIEW and file.
It is a draft, not a filed FIR, and the PDF says so on every page."""
import io
import json
from datetime import timezone

from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
from reportlab.lib import colors


def _fmt(ts) -> str:
    if ts is None:
        return "-"
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return ts.strftime("%Y-%m-%d %H:%M UTC")


def build_draft(*, incident, tourist_name: str, id_code: str, pii: dict | None, alerts: list, fixes: list) -> dict:
    last = fixes[-1] if fixes else None
    return {
        "status": "DRAFT - for officer review, not filed",
        "incident_id": incident.id,
        "opened_at": _fmt(incident.opened_at),
        "missing_person": {"name": tourist_name, "digital_id": id_code,
                           "kyc_number": pii["values"]["kyc"] if pii else "(erased after visit end)"},
        "itinerary": pii["values"]["itinerary"] if pii else None,
        "emergency_contacts": pii["values"]["contacts"] if pii else [],
        "last_known_position": ({"lat": last.lat, "lon": last.lon, "time": _fmt(last.ts)} if last else None),
        "recent_track": [{"lat": f.lat, "lon": f.lon, "time": _fmt(f.ts)} for f in fixes[-20:]],
        "alert_log": [{"time": _fmt(a.created_at), "kind": a.kind, "rule": a.rule, "detail": a.detail,
                       "status": a.status} for a in alerts],
    }


def render_pdf(d: dict) -> bytes:
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm,
                            topMargin=18 * mm, bottomMargin=18 * mm, title="Draft e-FIR")
    st = getSampleStyleSheet()
    S = lambda t, s="BodyText": Paragraph(t, st[s])
    mp = d["missing_person"]
    story = [S("DRAFT e-FIR - MISSING TOURIST", "Title"),
             S(f"<b>{d['status']}</b>. Generated from the tourist-safety system for an officer to review, "
               "correct and file. Not a registered FIR."),
             Spacer(1, 6 * mm),
             S("1. Missing person", "Heading2"),
             S(f"Name: {mp['name']}<br/>Digital tourist ID: {mp['digital_id']}<br/>ID document no.: {mp['kyc_number']}"),
             S("2. Last known position", "Heading2")]
    lk = d["last_known_position"]
    story.append(S(f"{lk['lat']:.5f}, {lk['lon']:.5f} at {lk['time']}" if lk else "No location received."))
    story.append(S("3. Itinerary", "Heading2"))
    it = d["itinerary"]
    if it:
        stops = "; ".join(f"{s['name']} ({s['lat']:.4f}, {s['lon']:.4f})" for s in it.get("stops", [])) or "none recorded"
        story.append(S(f"Planned stops: {stops}"))
    else:
        story.append(S("Itinerary no longer available (personal data erased)."))
    story.append(S("4. Emergency contacts", "Heading2"))
    story.append(S("<br/>".join(f"{c['name']}: {c['phone']}" for c in d["emergency_contacts"]) or "None available."))
    story.append(S("5. Alert log", "Heading2"))
    rows = [["Time", "Kind", "Detail", "Status"]] + [[a["time"], a["kind"], a["detail"][:60], a["status"]] for a in d["alert_log"]]
    t = Table(rows, repeatRows=1, colWidths=[38 * mm, 25 * mm, 80 * mm, 25 * mm])
    t.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.4, colors.grey), ("FONTSIZE", (0, 0), (-1, -1), 8),
                           ("BACKGROUND", (0, 0), (-1, 0), colors.lightgrey)]))
    story += [t, S("6. Recent track (last 20 fixes)", "Heading2")]
    story.append(S("<br/>".join(f"{p['time']}: {p['lat']:.5f}, {p['lon']:.5f}" for p in d["recent_track"]) or "No track."))

    def footer(canvas, _):
        canvas.setFont("Helvetica", 8)
        canvas.drawString(18 * mm, 10 * mm, "DRAFT - for officer review - not a filed FIR")

    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    return buf.getvalue()
