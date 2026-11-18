from sqlalchemy import create_engine, inspect, text
from sqlmodel import Session, SQLModel

from app import db as appdb
from app.models import Alert


def test_old_database_gets_new_alert_columns_and_keeps_data(tmp_path):
    """Regression: a Phase-1 database lacked alert.score/rule/incident_id and /api/alerts/mine returned 500."""
    eng = create_engine(f"sqlite:///{(tmp_path / 'old.db').as_posix()}")
    with eng.begin() as c:   # the Alert table exactly as it looked before Phases 5-6
        c.execute(text("CREATE TABLE alert (id INTEGER PRIMARY KEY, tourist_id INTEGER NOT NULL, kind VARCHAR NOT NULL,"
                       " detail VARCHAR NOT NULL, lat FLOAT, lon FLOAT, status VARCHAR NOT NULL, created_at DATETIME NOT NULL)"))
        c.execute(text("INSERT INTO alert (tourist_id, kind, detail, status, created_at) "
                       "VALUES (1, 'panic', 'old row', 'open', '2026-01-01 00:00:00')"))
    SQLModel.metadata.create_all(eng)          # does nothing to the existing table (the original bug)
    assert "score" not in {c["name"] for c in inspect(eng).get_columns("alert")}

    added = appdb.add_missing_columns(eng)
    assert {"alert.score", "alert.rule", "alert.incident_id"} <= set(added)
    with Session(eng) as s:
        row = s.query(Alert).one()             # the query that used to raise "no such column"
        assert row.detail == "old row" and row.score is None and row.incident_id is None
    assert appdb.add_missing_columns(eng) == []   # idempotent
