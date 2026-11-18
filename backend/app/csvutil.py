"""CSV export helpers. Cells that start with = + - @ (or a tab/CR) are prefixed with an apostrophe so a spreadsheet
never treats exported text (notes, details, names) as a formula."""
import csv
import io
from datetime import datetime

_DANGEROUS = ("=", "+", "-", "@", "\t", "\r")


def safe_cell(v) -> str:
    if v is None:
        return ""
    if isinstance(v, datetime):
        return v.isoformat()
    s = str(v)
    return "'" + s if s.startswith(_DANGEROUS) else s


def to_csv(header: list[str], rows: list[list]) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(header)
    for r in rows:
        w.writerow([safe_cell(c) for c in r])
    return buf.getvalue()
