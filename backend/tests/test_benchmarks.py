from app import benchmarks
from tests.test_ledger_api import H, issue_body, setup_users, token


def test_fast_benchmarks_meet_the_paper_limits(client, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)   # the benchmark creates its own throw-away signing key
    assert benchmarks.ledger_check_us() < 1000
    assert benchmarks.geo_lookup_us(n_zones=1000, n_fixes=1500) < 100
    assert benchmarks.false_geo_alerts_per_km(km=10) < 0.01
    assert benchmarks.entry_delay_median_s(trials=15) < 60
    assert benchmarks.panic_publish_s() < 10


def test_table5_endpoint_rows_and_roles(client, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    off, tour, adm = setup_users(client)
    client.post("/api/ledger/issue", json=issue_body(), headers=H(off))
    client.post("/api/auth/staff", headers=H(adm), json={"email": "p@x.com", "full_name": "P",
                "password": "password123", "role": "police"})
    pol = token(client, "p@x.com")
    assert client.get("/api/evaluation/table5", headers=H(tour)).status_code == 403
    assert client.get("/api/evaluation/table5").status_code == 401
    d = client.get("/api/evaluation/table5", headers=H(pol)).json()
    rows = {r["measure"]: r for r in d["rows"]}
    assert rows["Personal data on the ledger"]["status"] == "met"
    for m in ("ID check time", "Geo-fence lookup per fix", "False geo-fence alerts per km",
              "Entry alert delay (median)", "Panic alert to dashboard"):
        assert rows[m]["status"] == "met", rows[m]
    assert rows["Anomaly false alerts / recall"]["status"] == "not run"       # detection not requested
    for m in ("Battery use per 8 h day", "SUS usability score"):
        assert rows[m]["status"] == "next stage"          # field-trial rows are never faked


def test_personal_data_check_detects_a_leak(client):
    from sqlmodel import Session
    from app import db as appdb
    from app.models import LedgerRecord
    off, _, _ = setup_users(client)
    client.post("/api/ledger/issue", json=issue_body(), headers=H(off))
    with Session(appdb.engine) as s:
        assert benchmarks.ledger_has_no_personal_data(s)
        rec = s.query(LedgerRecord).first()
        rec.record_json = rec.record_json[:-1] + ',"kyc":"AADHAAR-1"}'
        s.add(rec)
        s.commit()
        assert not benchmarks.ledger_has_no_personal_data(s)
