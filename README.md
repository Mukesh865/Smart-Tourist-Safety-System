# Smart Tourist Safety Monitoring and Incident Response System

Working website for the final-year project based on the IEEE paper *"Smart Tourist Safety Monitoring and
Incident Response System Using AI, Geo-Fencing and a Blockchain-Based Digital ID"* (AKGEC, Ghaziabad).

| Paper component | Where it is implemented |
|---|---|
| Ledger-anchored digital ID (salted commitments, Merkle blocks, ECDSA P-256, QR, offline verify, DPDP erasure) | `backend/app/ledger/`, officer page `/officer`, tourist ID, public `/verify` |
| Geo-fence service (grid index, ray casting, buffer `b = 4 sigma`, debounce `k = 3`, warning ring) | `backend/app/geo/`, zone manager `/zones` |
| Detection service (rules R1-R3, Isolation Forest, hybrid, 60-min cool-down) | `backend/app/detect/` |
| Tourist app (live GPS, panic + SMS fallback, safety score, family live view, Hindi/English) | `/tourist`, `/family/:token` |
| Police dashboard (live alerts, heat map, clusters, incident workflow, draft e-FIR) | `/dashboard` |
| Paper's Table V limits, measured | `/evaluation`, `backend/app/benchmarks.py` |
| ID lifecycle: revoke (signed hash-chained revocation list), extend/renew, itinerary editing, ledger explorer | `/tourists`, `/ledger`, `backend/app/routers/{tourists,ledger}.py` |
| Administration: users, roles, disable, password reset, audit log, system status | `/admin`, `/profile`, `backend/app/routers/admin.py` |

Everything the paper lists as *not yet built* (Android app, Hyperledger Fabric network, IoT bands, field trials)
is **not** part of this website. See "Limitations".

## Run it (Windows, from this folder)

```powershell
# first time only
cd backend;  python -m venv .venv;  .\.venv\Scripts\python.exe -m pip install -r requirements.txt;  cd ..
cd frontend; npm install; cd ..

# every time
.\run_dev.ps1            # starts backend on :8000 and frontend on :5173
```

Open http://localhost:5173.

| Account | Login | Purpose |
|---|---|---|
| Admin (dev only) | `admin@tourist.local` / `Admin@12345` | creates officer/police accounts, sees audit log |
| Tourist | register on the site | |
| Demo tourists | `demo1..3@tourist.local` / `Demo@12345` after pressing **Seed demo data** | |

Typical demo: admin creates an officer and a police user (`POST /api/auth/staff`, or use the API docs at
http://localhost:8000/docs) -> police opens `/dashboard` -> **Demo mode** -> *Seed*, then run *Signal drop-off*
or *Panic button* and watch the live alert, acknowledge it, open personal details, download the draft e-FIR.

## Tests

```powershell
cd backend;  .\.venv\Scripts\python.exe -m pytest -q          # about 3-4 minutes
cd frontend; npm test; npm run build                           # unit/component tests + type check + build
cd frontend; npm run e2e                                       # real browser, real servers (needs `npx playwright install chromium` once)
cd backend;  .\.venv\Scripts\python.exe -m app.detect.evaluate --full   # paper-scale Table III (about 5 minutes)
```

## Database migrations

Development creates and upgrades tables automatically on start. For a real database use Alembic:
`cd backend; .\.venv\Scripts\python.exe -m alembic upgrade head` (set `TS_DATABASE_URL` first). Existing development databases that were
created without Alembic can be adopted with `alembic stamp 0001` followed by `alembic upgrade head`.

## Layout

```
backend/app/   ledger/ geo/ detect/ routers/ models.py security.py demo.py efir.py benchmarks.py ...
backend/tests/ pytest suites (crypto, geo, detection, API, dashboard, demo, hardening, benchmarks)
frontend/src/  pages/ components/ store.ts i18n.ts useTracker.ts
frontend/e2e/  Playwright end-to-end spec
docs/          PHASE_LOG.md (what was done/installed/tested per phase), VIVA_NOTES.md
```

## Configuration (environment variables, prefix `TS_`, or `backend/.env`)

See `backend/.env.example`. With `TS_ENV=production` the server **refuses to start** unless `TS_SECRET_KEY`
(32+ chars), `TS_ADMIN_PASSWORD`, `TS_DEMO_ENABLED=false` and a non-SQLite `TS_DATABASE_URL` are set.

## Limitations (same honesty as the paper, Section VI)

- All movement data is **synthetic**. Detector results show method behaviour, not real-district accuracy.
  The Isolation Forest is trained on simulated normal days; per-district calibration from consented real tracks is future work.
- The ledger is a **single-authority signed hash chain on one server**, not a multi-organisation Hyperledger Fabric network.
- Web app, not a native Android app. GPS, battery and SMS behave differently on real phones; the SMS fallback is an `sms:` hand-off link.
  There is no service worker yet (not installable/offline).
- "Dispatch" only records a status; there is no radio/SMS/CAD integration. The e-FIR is a **draft** for an officer to review.
- Rate limiting and debounce counters are in memory (single process). Use a shared store for multiple workers.
- Not measured (need real users): battery use, real-network panic latency, SUS score. They show as "next stage" on `/evaluation`.
- Map tiles come from OpenStreetMap and need internet access.

## Troubleshooting

- **`no such column: alert.score` (or similar) after updating the code:** your SQLite file is from an older version.
  The server now adds missing columns automatically on start; just restart it. (Or delete `backend/tourist_safety.db`
  to start fresh, which also removes your accounts.)
- **Console full of `WatchFiles detected changes in '.venv\...'`:** run uvicorn with `--reload-dir app`
  (`run_dev.ps1` already does), otherwise the reloader watches the virtualenv.
