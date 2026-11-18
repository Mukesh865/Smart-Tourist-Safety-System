# Phase Log — Smart Tourist Safety System

Based on the IEEE paper "Smart Tourist Safety Monitoring and Incident Response System Using AI, Geo-Fencing and a Blockchain-Based Digital ID". Stack: FastAPI + SQLite (backend), React + Vite + TypeScript + Tailwind + Leaflet (frontend).

## How to run
- Backend: `cd backend; .\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8000`
- Frontend: `cd frontend; npm run dev` (proxies `/api` to port 8000) -> http://localhost:5173
- Tests: `cd backend; .\.venv\Scripts\python.exe -m pytest -q` and `cd frontend; npm test; npm run build`
- Seeded admin (dev only): `admin@tourist.local` / `Admin@12345`. Change before any real deployment.

---

## Phase 1 — Foundation & Auth  (DONE)

### What was done
- Repo layout: `backend/` (FastAPI), `frontend/` (React), `docs/`.
- Backend: settings (env-overridable, prefix `TS_`), SQLite engine, models (User, Tourist, Itinerary, Zone, Fix, Alert, Incident), bcrypt password hashing, JWT auth, role guard dependency `require_roles`, auth router, health endpoint, CORS, auto-seeded admin.
- Frontend: Tailwind styling, zustand auth store with token persistence/restore, axios client with bearer interceptor, login/register page, role-protected routes, shared layout, placeholder home pages per role.

### Installed
- Backend (pip, in `backend/.venv`; pinned in `backend/requirements.txt`): fastapi, uvicorn[standard], sqlmodel, pydantic-settings, pyjwt, bcrypt, cryptography, numpy, scikit-learn, shapely, qrcode[pil], reportlab, python-multipart, websockets, email-validator, pytest, httpx, pytest-asyncio. (Several are for later phases.)
- Frontend (npm): react 18, react-dom, react-router-dom, zustand, axios, leaflet, react-leaflet 4, leaflet.heat, recharts, html5-qrcode, qrcode.react; dev: vite, @vitejs/plugin-react, typescript, tailwindcss 3, postcss, autoprefixer, vitest, jsdom, @testing-library/react + jest-dom, @types/*.
- Note: `npm create vite` produced a vanilla-TS scaffold; it was converted to React manually.

### Functionality
- Tourist self-registration (always the tourist role) and login; `GET /api/auth/me`.
- Admin-only creation of officer/police/admin accounts (`POST /api/auth/staff`).
- Role-based routing: tourist -> /tourist, officer -> /officer, police -> /dashboard, admin -> /admin; wrong role is redirected.

### Tests
- Backend pytest: 5 passed (health, register/login/me, duplicate email + bad password + weak password, missing/invalid token, role guard on staff creation).
- Frontend vitest: 4 passed (unauth redirect, register form, tourist blocked from dashboard, police allowed). `npm run build` succeeds (tsc + vite).
- Live smoke test: started uvicorn on port 8000, `/api/health` ok, seeded admin logged in, `/api/auth/me` returned the admin.
- Not tested yet: in-browser visual check (no browser automation used); done in later phases.

---

## Phase 2 — Blockchain-style Digital ID Ledger  (DONE)

### What was done
- `backend/app/ledger/core.py`: pure crypto primitives from paper Sec. III-D: salted SHA-256 commitments H(salt||value), record r_u, Merkle tree (domain-separated leaf/node hashes, odd-node duplication), Merkle path / root recompute, ECDSA P-256 header signing, credential (QR payload) build + offline `verify_credential`.
- `backend/app/ledger/service.py`: DB-backed ledger. Issuing writes a signed block (height, prev-header hash, Merkle root, time, signature) + a record of commitments only; PII (KYC, itinerary, contacts + salts) is Fernet-encrypted in an off-chain table. Chain audit (`verify_chain`) and DPDP-style erasure of expired PII (`erase_expired`).
- `backend/app/routers/ledger.py`: `POST /api/ledger/issue` (officer/admin), `GET /api/ledger/my-credential` (tourist), `POST /api/ledger/verify` (public), `GET /api/ledger/pubkey`, `GET /api/ledger/chain` (admin/police), `POST /api/ledger/erase-expired` (admin). Issuing also links the ID to the tourist account and stores the itinerary.
- Frontend: Officer issue form + QR (`/officer`), Tourist "My Digital ID" QR page (`/tourist`), public Verify page with camera QR scan or paste (`/verify`).
- Keys (authority signing key, PII encryption key) are generated on first run into `backend/keys/` (git-ignored).

### Installed
- Backend: nothing new (cryptography, qrcode already installed in Phase 1).
- Frontend: `@testing-library/user-event` (dev).

### Functionality
Officer issues ID -> tourist sees QR -> anyone verifies it (valid / tampered / expired) -> admin can audit the entire chain and erase expired personal data.

### Deliberate differences from the paper (be ready to explain in viva)
- Each issuance seals its own block (so the tourist gets the QR instantly). Paper uses blocks of B=256; the code supports any block size and the tests use B=256. With 1-record blocks the Merkle path is empty and the QR is ~460 B; with B=256 it is 845 B (paper: 743 B using a binary encoding; we use JSON/base64, still far below the 2,953 B QR limit).
- Single-authority hash chain on one machine (same as the paper's prototype; Hyperledger Fabric is listed there as future work).

### Tests
- Backend: 25 passed total (13 new ledger-core, 7 new ledger-API). Covers: every record of an odd-sized block verifies; path length 8 for B=256; QR payload <2,953 B (845 B measured); no PII in record; commitment reveal; validity window; 300 trials each of tampered record / flipped header bit / forged re-rooted block, all detected; wrong authority key; malformed payload; verify time ~106 us (<1,000 us limit; paper 54 us on M2); chain linkage; end-to-end issue->verify API; role guards; chain audit detects a DB-corrupted record; PII ciphertext does not contain plaintext and is erased after expiry while hashes remain.
- Frontend: 8 vitest passed; `npm run build` OK (only a >500 kB chunk-size warning).
- Live test on a real server (temp DB/keys): issued an ID, verified valid, tampered payload rejected, chain audit ok.
- Not tested: camera QR scanning (needs a real device/browser); only the paste path is tested.

---

## Phase 3 — Geo-Fencing Engine & Zone Management  (DONE)

### What was done
- `backend/app/geo/engine.py` (paper Sec. III-B / Algorithm 1 `OnFix`): equirectangular projection, ray-casting point-in-polygon, signed distance-to-boundary, 1 km grid index with padded bounding-box reject, **debounce k=3** consecutive fixes at least **buffer b=20 m (4 sigma)** inside a zone (buffer widens to 2.6 x reported accuracy when the phone reports worse accuracy), **warning ring (50 m)** for no-entry zones, alert fires once per entry and re-arms after leaving, per-tourist counters, `nearby_risk` (Z term of the future safety score).
- `backend/app/geo/manager.py`: process-wide engine rebuilt from the Zone table whenever zones change.
- API: zone CRUD (`/api/zones`; read = any logged-in user, write = police/admin), `POST /api/location` (tourist with an issued ID only; stores the fix, runs the engine, creates Alert rows, returns adaptive next interval 15 s near a risk zone / 60 s elsewhere), `GET /api/alerts` (police/admin, filter by status/kind), `GET /api/alerts/mine`.
- Frontend: `/zones` page (police/admin): Leaflet map, click-to-draw polygon, name / risk slider / no-entry flag, list + delete. `/admin` redirects there.

### Installed
Nothing new (shapely, numpy, leaflet, react-leaflet were installed in Phase 1).

### Tests (all passing)
- Backend: 47 passed in total (14 new geo-engine, 8 new zone/location API).
  - Projection error < 0.08 % over a 20 km box (paper's claim).
  - Grid index returns exactly the same zones as a full scan **and** as a shapely oracle, at 10 / 100 / 1,000 / 5,000 zones.
  - Lookup time with 5,000 zones: **70 us per fix** on this laptop (limit < 100 us). The paper reports 8.0 us on an Apple M2; this margin is thinner and may vary by machine. A first version without a bounding-box reject took 228 us and failed, which is why that reject was added.
  - Walker along a zone edge with time-correlated (Gauss-Markov, 5 m) GPS error: debounce alone (k=1 vs k=4, b=0) does not remove most false alerts, while buffer 20 m + k=3 gives < 0.01 false alerts/km both 20 m outside and exactly on the edge (reproduces the paper's finding).
  - Median entry delay 51.7 s (< 60 s limit; the paper reports 38 s; our start offsets differ).
  - Alert fires once per entry and re-arms; shallow entry blocked by buffer; no-entry warning ring; per-tourist independence; accuracy widens buffer; nearby risk.
  - API: zone CRUD + role guards, validation (too few corners, bad risk, bad coordinates), entry alert on the 3rd fix visible to police and tourist, adaptive interval, zone edits applied immediately, tracking refused without an ID or for non-tourists.
- Frontend: 11 vitest passed (3 new Zones tests); `npm run build` OK.
- Not tested: drawing by actually clicking the Leaflet map (jsdom cannot do it), real map tiles, and the paper's 200 km edge walk (we ran 40 km per case to keep tests fast).
- Known limitation: debounce counters are in memory (reset on server restart or zone edit).

---

## Phase 4 — Tourist Web App (PWA-style)  (DONE)

### What was done
- Backend: `POST /api/panic` (uses the last fix if no coordinates are given; returns the tourist's own decrypted emergency contacts so the app can build an SMS fallback), `GET /api/me/score` (safety score S = 100(1-0.5Z-0.2N-0.3A); Z from the geo engine, N = 20:00-05:00 IST, A from the detection service, 0 until Phase 5), family sharing (`POST /api/me/share`, public `GET /api/share/{token}` returns first name + last fix only, works only while opted in, revocable), `PUT /api/me/language` (en/hi), `GET /api/me/profile`. `app/events.py` is an in-process alert pub/sub (WebSockets attach in Phase 6).
- Frontend: tourist page `/tourist` with big PANIC button, SMS fallback link when the server is unreachable (`sms:112,<contacts>` with a map link), safety score, live map with zones and own position, GPS tracker hook (`useTracker`: uploads a fix at the server-dictated interval, 15 s near risk zones / 60 s elsewhere, retries after failures), zone-entry warnings, family-share toggle with link, English/Hindi switch (`i18n.ts`), ID QR, recent alerts. Public family view `/family/:token`.

### Installed
Nothing new.

### Tests (all passing)
- Backend: 57 passed in total (10 new). Score formula + clamping + night boundaries; panic with/without a fix, explicit coordinates, validation, role checks; panic reaches subscribers in well under 10 s (paper limit < 10 s, server side only); a failing subscriber cannot block panic; score endpoint reflects zone risk; family share opt-in / revoke / no private data in the public view; language switch.
- Frontend: 17 vitest passed (7 new tourist-page tests: ID + score, no-ID state disables panic, panic payload + SMS link with contacts, offline fallback, share toggle, Hindi switch, translation fallback, SMS link format). Build OK.
- Fixed during testing: `zoneinfo` has no Asia/Kolkata on Windows, so IST is a fixed +05:30 offset (India has no DST).
- Not tested: real GPS and real phone behaviour (needs a device and HTTPS; Geolocation is mocked), real SMS sending (a `sms:` link is only a hand-off to the phone's SMS app), battery use and real alert delivery time (paper's field tests). Hindi is the only translation besides English. There is no service worker, so it is not yet installable/offline.

---

## Phase 5 — Movement Anomaly Detection Service  (DONE)

### What was done
- `backend/app/detect/simulator.py`: tourist-day simulator per paper Sec. IV (60 POIs in 20 km x 20 km, nearest-first visits, walking/driving speeds, planned and lunch stops, Gauss-Markov GPS error, 2 % lost fixes, signal gaps, unplanned stops, detours; drop-off / inactivity / deviation anomalies at 25-75 % of the day; "shifted" benign variant).
- `backend/app/detect/detectors.py`: six per-minute features (+2 helper columns), rules R1 (no fix > 20 min), R2 (still > 40 min and > 200 m from any planned stop, or > 150 min anywhere but the hotel), R3 (> 1 km from route for 10 min), Isolation Forest (200 trees x 512 rows, trained on normal days, threshold at the 99.5th percentile of validation scores, persistence p = 10), and Algorithm 1's alert logic with 60-min cool-down.
- `backend/app/detect/evaluate.py`: reproduces paper Table III. CLI: `python -m app.detect.evaluate [--full]`.
- `backend/app/detect/service.py` + `routers/detection.py`: live per-minute service. **Rules raise the alerts; the Isolation Forest only gives each alert a 0-1 priority score** (the paper's own conclusion). It skips stale (> 12 h) and expired-ID tourists, publishes alerts to the live feed, and feeds the safety score's A term (so the score drops by 30 points when an alert fires). A background loop runs every 60 s and trains the ranking forest on first start if no saved model exists (`backend/models/`). `POST /api/detection/run`, `GET /api/detection/status` for police/admin.
- `Alert` now has `score`, `rule` columns.

### Installed
Nothing new (scikit-learn, numpy, joblib came with it).

### Results — paper scale (1,200 train / 400 val days, 1,000 normal + 3 x 200 anomalous test days), our implementation vs the paper
| | Ours matched | Paper matched | Ours shifted | Paper shifted |
|---|---|---|---|---|
| Rules recall / false alerts per 100 days | 99.3 % / 0.0 | 99.7 % / 0.0 | 99.3 % / 52.3 | 99.3 % / 27.0 |
| Forest recall / FA | 35.2 % / 4.2 | 62.5 % / 5.4 | 42.7 % / 21.2 | 67.2 % / 22.4 |
| Hybrid recall / FA | 99.3 % / 3.9 | 99.7 % / 5.4 | 99.3 % / 60.7 | 99.3 % / 36.9 |
- Matches the paper: rules perfect on matched days; rule false alerts explode on shifted days; forest finds only ~2 % of inactivity cases (paper 3 %); forest finds drop-offs ~6 min sooner (14 vs 20 min; paper 13.8 vs 19.5); rules inactivity delay ~102 min (paper 104).
- **Differs from the paper:** the forest detects only ~3 % of deviations (paper 84.5 %), which is why its overall recall is 35 % instead of 62.5 %. Likely reason: an Isolation Forest does not extrapolate beyond its training range, so a far-away point is not isolated quickly; the paper's implementation details may differ. Rule false alerts on shifted days are about 2x the paper's (52 vs 27). We did not tune toward the paper's numbers. The qualitative conclusion (rules primary, forest only ranks) is unchanged and, if anything, stronger.
- Counting rule: once an anomaly is caught the incident is open, so later repeat alerts on that day are not counted as false (before-onset alerts and missed anomalies are).
- All data is synthetic; this shows method behaviour, not real-district performance (same caveat as the paper).

### Tests (all passing)
- 17 detector tests: each rule on hand-made tracks (silence, tolerated 15-min gap, parked away from stops, long stop at planned site, hotel never triggers, 1 km deviation vs 800 m detour vs 7-min excursion, silent phone does not trigger R3), feature values, cool-down and persistence logic, simulator properties, and a reduced-scale Table III reproduction asserting the paper's limits (recall >= 95 %, <= 5 false alerts/100 matched days) and findings.
- 11 live-service tests: normal walk silent; drop-off alert + cool-down + re-alert; deviation; inactivity; stale/expired skipped; alerts published; forest never raises alone but scores alerts; no model = no score; model persists; anomaly term lowers the score by exactly 30; role guards.
- Total backend after this phase: 85 passed.
- Not tested: real GPS tracks; the forest is trained on simulated normal days only (there is no real data). Per-district threshold calibration is future work, as in the paper.

---

## Phase 6 — Police Dashboard & Incident Response  (DONE)

### What was done
- Backend: WebSocket `/api/ws/alerts?token=` (police/admin only) pushes every new alert (panic, zone entry/warning, detector alerts); ranked queue `GET /api/dashboard/alerts` (panic first, then rule order, then forest priority); `GET /api/dashboard/overview` (last positions identified by pseudonymous ID code only, ~1 km clusters, alert and risk heat points, counts); incident workflow `PATCH /api/alerts/{id}` (open -> acknowledged -> dispatched -> resolved, forward only; acknowledging opens/links an incident per tourist, which closes when all its alerts are resolved); **personal data opens only for an active incident** (`POST /api/incidents/{id}/reveal`; 410 if already erased); **draft e-FIR** (`GET /api/incidents/{id}/efir` JSON and `/efir.pdf`) pre-filled from the ID record, itinerary, last position, track and alert log and stamped "DRAFT - not a filed FIR"; every ack/dispatch/resolve/reveal/e-FIR is written to an `AuditLog` (admin-only `GET /api/audit`). Zone alerts are now also published live.
- Frontend `/dashboard`: live/offline badge with auto-reconnect, toast on new alert, stats, Leaflet map (zones, tourist positions, clusters, heat layer), alert queue with workflow buttons, "Open personal details" panel, e-FIR PDF download, show-resolved toggle, link to zone manager. Removed the unused placeholder page.

### Installed
Nothing new (reportlab was installed in Phase 1).

### Tests (all passing)
- Backend 96 total (11 new): WebSocket receives panic, zone-entry and detector alerts live and within the paper's 10 s limit; WebSocket refuses missing/invalid/tourist tokens; ranked queue order; overview contains no name, KYC or email; transitions cannot be skipped or reversed; two alerts share one incident which closes only when both are resolved; PII reveal refused for tourists, nonexistent or closed incidents, returns 410 after erasure, and is audited; e-FIR contents (name, KYC, contacts, itinerary stops, last position, track, alert log), valid PDF bytes, role guard, closed incident refused, audit entries written.
- Frontend 25 total (8 new dashboard tests with a fake WebSocket): queue/stats/live badge, live alert toast + refresh, reconnect after drop, acknowledge flow, personal-details panel and erased-record message, e-FIR blob request, resolved alerts without buttons, priority percentage.
- Not tested: the real browser WebSocket against a running server (only TestClient and a fake socket), the heat layer (mocked; jsdom has no canvas), PDF visual layout (only that a PDF is produced), and real dispatch (the "Dispatch" button only records status; there is no radio/SMS integration).

---

## Phase 7 — Trajectory Simulator & Demo Mode  (DONE)

### What was done
- `backend/app/demo.py` + `routers/demo.py` (police/admin; disable with `TS_DEMO_ENABLED=false`): `POST /api/demo/seed` (idempotent: 2 demo zones near Shillong, 3 demo tourists `demo1..3@tourist.local` / `Demo@12345` with real issued ledger IDs and itineraries), `POST /api/demo/scenario` (normal, dropoff, inactivity, deviation, zone_entry, border_warning, panic), `POST /api/demo/reset`, `GET /api/demo/scenarios`.
- Scenarios are **not faked**: tracks are replayed with virtual timestamps through the same `process_fix` function the phone endpoint uses (geo-fence engine) and through the detection service once per virtual minute, so alerts, WebSocket pushes, dashboard queue, incidents and e-FIR all work on them.
- Refactor: `POST /api/location` now calls a reusable `process_fix()`.
- Frontend: "Demo mode" panel on the police dashboard (seed, reset, pick demo tourist, run scenario, shows which alerts fired). Hidden automatically if demo mode is disabled.

### Bugs found and fixed in this phase
1. **R3 fired on the very first fix** of a track that started far from the route (the paper requires 10 minutes beyond 1 km). R3 now needs 10 minutes of tracking history. Regression test added; paper-scale results are unaffected in practice because anomalies start mid-day.
2. **Scenarios polluted each other** when run back-to-back on the same tourist (old fixes overlapped the new timestamps and filled the silence, so a drop-off raised nothing). Found only by the live run against a real server, not by the unit tests. Each scenario now starts from an empty track for that tourist; a chain regression test was added.
3. A demo scenario never reached the no-entry warning ring and the belt was placed 3 km off-route (would also trip R3); geometry corrected.

### Installed
Nothing new.

### Tests (all passing)
- Backend: 16 demo tests: idempotent seed, demo login + ID verification, normal = no alert, each scenario produces exactly its alert through the real pipeline and appears in the dashboard queue, alert timing matches the rules (R1 ~minute 50, R2 ~51, R3 ~25), chained scenarios on one tourist, per-tourist isolation, live WebSocket sees the alert, reset removes only demo data, role/validation guards, demo can be disabled, and a full incident from scenario to acknowledge, reveal and e-FIR PDF.
- Frontend: 28 vitest in total (3 new demo-panel tests); build OK.
- **Live run on a real uvicorn server with a real WebSocket client:** seed, then normal / dropoff / zone_entry / inactivity / deviation / panic scenarios each produced the expected alert and the WebSocket received it; reset emptied the queue.
- Not tested: simulated tourists do not move through real time (replay is instantaneous with virtual timestamps), so the per-minute scheduler loop itself is not exercised by the demo.

---

## Phase 8 — Hardening, Evaluation & Documentation  (DONE)

### What was done
- **Security:** sliding-window rate limits (login 8/min per address+account and 60/min per address, registration 10/hour, public verify 120/min, panic 20/min and location 60/min per user; 429 + `Retry-After`); security headers on every response (`nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, `Cache-Control: no-store` on `/api`); admin password configurable (`TS_ADMIN_PASSWORD`); **production safety check**: with `TS_ENV=production` the server refuses to start with the default secret/admin password, demo mode on, or SQLite; frontend signs the user out automatically on any 401 (expired/revoked token).
- **Evaluation:** `backend/app/benchmarks.py` + `GET /api/evaluation/table5` + page `/evaluation` measure the paper's Table V live (ID check time, geo lookup, false geo alerts per km, entry delay, panic publish latency, personal data on ledger, optional detection benchmark). Field-trial rows (battery, SUS, real-network panic) are shown as "next stage", never faked.
- **Performance:** routes are lazy-loaded; the >500 kB bundle warning is gone (largest chunk 370 kB, the QR scanner).
- **End-to-end tests (Playwright, real Chromium, real backend + frontend, throw-away DB):** full flow and two more specs.
- **Docs:** `README.md` (run, accounts, tests, layout, config, limitations), `docs/VIVA_NOTES.md` (talking points, where results differ from the paper, likely questions), `run_dev.ps1`, `backend/.env.example`, refreshed `backend/requirements.txt`.

### Installed
- Frontend dev: `@playwright/test` and the Chromium browser (downloaded to `C:\Users\Asus\AppData\Local\ms-playwright`).

### Tests (final state, all passing)
- **Backend: 128 passed** (about 4.5 min). New in this phase: 12 hardening tests (brute-force/registration/verify/panic/location throttling incl. "right password still waits", headers, CORS allows only the configured origin, production refusal to start, bcrypt-hashed admin, expired/forged/unsigned (`alg: none`) JWTs rejected, token role claim ignored in favour of the DB role, no private material in the public key endpoint) and 3 benchmark tests (all fast paper limits met; Table V endpoint; the "no personal data" check really detects a leak).
- **Frontend: 32 vitest passed** (stable over 3 consecutive runs), `npm run build` OK.
- **E2E: 3 Playwright tests passed** in a real browser: (1) tourist registers -> officer issues ID in the UI -> ID verifies and a tampered code is rejected -> police dashboard goes Live -> tourist presses PANIC -> alert appears live -> acknowledge -> personal details open -> e-FIR PDF downloaded (starts with `%PDF`) -> dispatch -> resolve -> admin audit log has ack/reveal_pii/efir/dispatch/resolve; (2) wrong password error and staff page redirect; (3) demo seed + drop-off scenario produces a DROPOFF alert on the dashboard.
- Test-suite problems fixed along the way: vitest was picking up the Playwright spec (now excluded); lazy pages made two tests timing-dependent (waits made explicit, default async timeout 5 s); an E2E test raced the login redirect.
- Not tested: a real phone (GPS/HTTPS/camera QR scan), real SMS, a multi-worker deployment (rate limits and debounce counters are in-memory), load beyond the paper's 10,000-tourist back-of-envelope, `.env` parsing of every variable (only `TS_CORS_ORIGINS`, `TS_ENV`, `TS_DETECTION_INTERVAL_S` were checked).

---

## Overall status
All 8 planned phases are complete and tested. Totals: backend 128 tests, frontend 32 tests, 3 end-to-end browser tests.
What remains is exactly what the paper defers: Android app, real Hyperledger Fabric network, IoT bands, per-district calibration from consented real tracks, and field trials (battery, real-network panic, SUS).

---
---

# Improvement round (plan v2: better frontend, functionality, usability)

## Phase 9 — Design system & app shell  (DONE)

### What was done
- **Design tokens** (`src/index.css`): RGB-triplet CSS variables for base/surface/ink/muted/line/brand/danger/warn/ok in light and dark; Tailwind semantic colours (`bg-surface`, `text-muted`, `bg-brand/15` ...) in `tailwind.config.js` with `darkMode: 'class'`. Every existing page was remapped from hard-coded colours to tokens, so **dark mode works everywhere**. Leaflet tiles dim in dark mode; reduced-motion respected; visible focus rings.
- **UI kit** (`src/ui/`): Button (variants, loading), Card, Badge, StatCard, Spinner, Skeleton, EmptyState, Field/TextInput/SelectInput (label, hint, error wired with `aria-describedby`/`aria-invalid`), Modal (Escape, focus in/out), ConfirmDialog, Tabs, ErrorBoundary, inline SVG icon set (no new dependency), **ToastProvider** (`useToast`; errors announced as `role=alert`), **ThemeProvider** (light / dark / system, persisted, follows the OS).
- **App shell** (`components/AppShell.tsx`, `Layout.tsx` is now an alias): staff get a role-aware left sidebar (mobile drawer) + header; tourists get a header and a bottom tab bar; theme toggle, EN/Hindi switch (saved to the account), log out, skip-to-content link.
- **Login/register redesign**: split layout, show/hide password, live password-strength meter (guidance only; the server enforces the rule), friendly message on rate limiting (429), dev-only quick-fill buttons (not in production builds), link to the public verify page.
- E2E now runs on its own ports (API 8100, web 5273) so it never collides with a developer's running servers.

### Installed
`axe-core`, `@axe-core/playwright`, `@types/node` (dev).

### Bugs found by the new real-browser accessibility scan (jsdom cannot see these) and fixed
1. Toast container had `aria-label` without a role (invalid ARIA).
2. Low-contrast text on the login brand panel (opacity) and on active nav items (teal on tinted background): light-mode link colour darkened.
3. QR images had no accessible name.
4. The icon-only log-out button had no name on phones.
5. White text on the light-red/amber colours used in dark mode (panic button, alert badges): dark text variant; the panic button is now a solid red in both themes.
6. `tsc` flagged `process` in `vite.config.ts`: Node types added.

### Tests (all passing)
- Frontend **59 vitest** (27 new): button loading, field a11y wiring, modal focus/Escape/focus-return, confirm dialog, toast roles and auto-dismiss, theme toggle/persist/system/blocked storage, shell navigation per role, tourist tab bar, mobile drawer, skip link, password-strength helper, show/hide password, rate-limit message, tabs/badge/empty state/error boundary, **axe scans** of the shell and both auth pages.
- **E2E 16 passed** in real Chromium: the 3 original flows, plus a visual/accessibility spec that visits login, register, dashboard, zones, officer, evaluation and the tourist page in **light and dark at 1440 px and 390 px** and runs axe (WCAG 2 A/AA incl. colour contrast) on each; screenshots are saved to `frontend/e2e/screenshots/` (git-ignored).
- `npm run build` OK (largest chunk 370 kB, the QR scanner).
- Not covered: pixel-level visual regression (screenshots are for human review only), real devices.

---

## Phase 10 — Admin console & account management  (DONE)

### What was done
- **Backend**
  - `User.disabled` and `User.token_version` columns. Tokens now carry a version claim; disabling an account, changing a role, changing/resetting a password or "sign out everywhere" bumps the version, so **old tokens stop working immediately** (REST and the live WebSocket). Tokens issued before this change (no claim) count as version 0 and keep working until the first bump.
  - `/api/admin/*` (admin only): user list with search / role / disabled filters and pagination, `PATCH /users/{id}` (role, disable/enable, name), `POST /users/{id}/reset-password` (random temporary password, shown once, never written to the audit log), `GET /stats` (users by role, IDs issued, ledger blocks, open alerts/incidents, environment flags), `GET /audit` (filter by action/user, pagination, actor names).
  - Safeguards: you cannot disable or demote yourself, and the last active administrator cannot be removed. Demoting someone to tourist creates their tourist profile. All admin actions are audited.
  - `POST /api/auth/change-password` (verifies the current password, rejects reuse, ends all other sessions, returns a fresh token, rate limited) and `POST /api/auth/logout-all`. Disabled users get a clear 403 only after supplying the right password.
  - **Alembic** added: `alembic/` with revision `0001` (baseline = schema at the end of Phase 9) and `0002` (user columns with safe server defaults). `alembic upgrade head` builds a fresh database identical to the models; the dev-time `add_missing_columns` fallback now also applies column defaults.
- **Frontend**
  - `/admin` (administrators): **Users** (debounced search, role filter, inline role change, disable/enable and reset-password with confirmation dialogs, one-time temporary-password dialog, add-staff dialog, pagination, empty/loading states), **System** (statistics cards, configuration flags, "Verify ledger chain", "Erase expired personal data" behind a confirmation), **Audit log** (action filter, pagination).
  - `/profile` for everyone: account summary, theme (system/light/dark), language, change password (live strength hint, mismatch check, new token stored), sign out of all devices (confirmed).
  - Navigation: "Administration" (admin) and "Profile" (all roles; third tab for tourists). Administrators now land on the dashboard.

### Installed
Backend: `alembic` (and its dependencies); `requirements.txt` refreshed.

### Tests (all passing)
- Backend **147 total** (18 new): role guards on every admin endpoint; search/filter/pagination; disable kills the existing token and blocks login (wrong password still gets 401, no hint); role change ends sessions and grants the new access; cannot lock out self or the last admin; reset password (shown once, not logged, ends sessions); change-password flow incl. other sessions ended; logout-all; legacy tokens; WebSocket refuses revoked tokens; audit entries with actor names and filters; stats contain no secrets; no-op patch keeps sessions; Alembic: `upgrade head` equals the models, upgrade from the baseline keeps existing users with default values, downgrade, and the dev fallback agrees with Alembic.
- Frontend **82 vitest** (23 new for Admin and Profile incl. axe accessibility scans).
- **E2E 18 passed** in real Chromium. New: an admin creates an officer in the UI; the officer signs in; the admin disables them and the officer is signed out on their next request and sees "disabled" when retrying; re-enable; reset password shows a one-time temporary password and the old one stops working; the officer logs in on a second browser, changes password on one and the other session ends; audit log shows the actions with the admin's name; ledger chain check; a plain tourist cannot reach `/admin`. `/admin` and `/profile` also pass the real colour-contrast scan in light/dark, desktop/phone.
- Found and fixed by the real-browser scan: the light-mode green used for "Active" badges failed contrast (darkened).
- **Flaky-test fix:** the two wall-clock speed checks (geo lookup, Table V benchmark) failed once when the whole suite ran 10 minutes on a loaded machine (145 µs vs the 100 µs limit; 67 µs when run alone). They now take the best of three runs, the standard way to benchmark on a busy machine. The thresholds are unchanged.
- Not covered: running Alembic against PostgreSQL (SQLite only); production migration of your existing `tourist_safety.db` should be done with `alembic stamp 0001` then `alembic upgrade head` if you adopt Alembic there (the dev server keeps using the automatic column fallback).

---

## Phase 11 — ID lifecycle, itinerary editor, ledger explorer, issue wizard  (DONE)

### What was done
- **Revocation** (`ledger/service.py`, `routers/ledger.py`): signed, hash-chained, append-only `RevocationEntry` list. `POST /api/ledger/{id}/revoke` (police/admin, reason required, audited), public `GET /api/ledger/revocations` (so check-posts can mirror it), `/revocations/audit` integrity check. `verify` now returns `revoked`, `revoked_at` and a reason; a revoked ID is **invalid even though its signature and dates are fine**. Revoked tourists are refused location tracking and are no longer monitored by detection, but **panic still works**. The tourist app shows a "revoked" banner with the reason.
- **Renew / extend** (`routers/tourists.py`): `POST /api/tourists/{id}/renew` re-issues the same verified details under a new ID code, revokes the old one as "superseded by ..." and moves the encrypted details (refused with 410 if they were already erased).
- **Tourist management** (officer/admin; police keep working from pseudonymous IDs): list with search by name/email/ID code, status (active / expiring within 48 h / expired / revoked / no ID) and pagination; detail; printable credential; `PUT /api/tourists/{id}/itinerary` updates the operational itinerary that detection uses (the ledger commitment still reflects what was declared at entry). All audited (`issue_id`, `revoke_id`, `renew_id`, `update_itinerary`).
- **Ledger explorer**: `GET /api/ledger/blocks`, `/blocks/{height}` (hashes and counts only, signature and Merkle-root checks per block, revoked flag per record). **Batch blocks**: `issue_many` seals many IDs in one signed block; the demo seed now issues its three tourists together.
- **Frontend**
  - `/officer` is a 5-step **issue wizard** (Tourist lookup -> Identity (masked, reveal toggle) -> Itinerary on a map -> Contacts and validity -> Review) ending in a printable **ID card**.
  - `/tourists` (search, status chips, ID card, Extend, Itinerary, admin-only Revoke).
  - `/ledger` explorer with integrity badges, block dialog, revoke action and the revocation list.
  - Verify page restyled, shows each check including "Not on the revocation list".
  - Reusable `ItineraryEditor` (click map to add stops/route, one hotel, remove/rename) and `IdCard`.
- Alembic revision `0003` for the revocation table.

### Installed
Nothing new.

### Bugs found and fixed
1. **Modal stole focus on every re-render** when the parent passed an inline `onClose`: typing in any dialog field lost focus after one character. Modal now moves focus once on open and always calls the latest `onClose`. Regression test added.
2. An empty table header (accessibility) in the explorer; the same-words-in-two-places ambiguity in tests.
3. An older test asserted the audit log held only ack/dispatch/resolve; it now ignores `issue_id`, which is rightly audited.

### Tests (all passing)
- Backend **167**: 20 new lifecycle tests (revoke -> verify invalid but crypto still fine; role guards and validation; revoked tourist refused tracking and not monitored; tourist sees the revoked state; revocation list is a verifiable chain and tampering is detected; renew supersedes the old ID, carries details over, refused after erasure / without ID / bad dates / wrong role; tourist list search/status/pagination and police blocked; status expiring/expired/revoked; ID card has no personal data; itinerary update changes whether the same position raises a deviation alert; explorer has no personal data and flags tampered blocks; **256 IDs in one block: 8-hash path, 854-byte QR payload, all verify, chain intact**; chained batches; audit trail).
- Frontend **112 vitest** (30 new: wizard flow, masking, validation, error handling, Tourists actions per role, Ledger integrity warnings, itinerary editor, modal focus regression, axe scans).
- **E2E 19 passed** in real Chromium: wizard in the main flow; new lifecycle spec (issue through the wizard with a map click, verify, extend and see the old ID rejected as superseded, edit the itinerary, police revoke from the explorer, public verify shows the reason, revocation list, tourist app banner, panic still enabled); `/tourists` and `/ledger` pass the real colour-contrast scan in light/dark, desktop/phone.
- Not covered: camera QR scanning, printing the card on paper (the print button and stylesheet exist; only the button is tested), PostgreSQL.

---

## Phase 12 — Tourist app v2 and installable offline PWA  (DONE)

### What was done
- **Backend**
  - `POST /api/location/batch` (up to 200 fixes, processed oldest-first through the same geo-fence pipeline, rate limited): duplicates (same device timestamp) are skipped so retries are safe, fixes older than 48 h are rejected, a phone clock up to 5 min ahead is clamped to "now". The single-fix endpoint de-duplicates the same way.
  - `POST /api/panic` accepts the phone's press time; requests delivered late after being offline are labelled for the control room. `POST /api/panic/{id}/cancel` lets the tourist cancel an accidental press while it is still unseen (not after the control room acknowledges, not after 10 min); the dashboard is notified. `Alert.resolution` column (Alembic `0004`).
  - `GET /api/me/trip` and `GET /api/me/contacts`; `alerts/mine` now exposes `resolution` so the app can show delivery status.
- **Offline outbox** (`src/offline/queue.ts`, IndexedDB with in-memory fallback): fixes are stored with their device timestamp, capped at 2,000, flushed oldest-first in batches (a batch is removed only after the server accepted it; the first failure stops the flush); panic requests are kept separately and sent first. Operations are serialised so nothing is lost when a flush and a new fix overlap.
- **Tourist app** (`src/pages/tourist/`): one provider keeps GPS tracking, the outbox and panic state alive across five tabs. Home (score ring, status from zones, hold-to-send panic, delivery status, next stop), Map (zones, planned route, trail, "inside / N m away" banner, centre-on-me), Safety (score breakdown using the paper's weights, alerts, tips), ID (QR card, revoked banner), Settings (tracking, family link with copy and QR, emergency contacts, install button, link to account). English and Hindi, with a test that every key exists in every language and placeholders survive.
- **Panic UX**: press-and-hold 1.5 s with a progress ring (pointer, touch, or held Space/Enter; early release, leaving the button or losing focus cancels; vibrates on completion), plus "can't hold?" confirmation for accessibility. Status steps: saved offline -> sent -> seen by control room -> help on the way -> closed, with cancel while unseen, and the SMS fallback when offline.
- **PWA** (`vite-plugin-pwa`): manifest, generated icons (192, 512, maskable, Apple touch), service worker that precaches the app shell (38 files) and caches a few API reads (zones, trip, contacts, profile, own credential) and map tiles. The API cache is deleted on logout so another person on the same phone cannot see it. Install prompt hook; `registerSW` in `main.tsx`.
- Session handling for offline use: the last profile is cached; a reload with no network no longer signs the user out (only a 401/403 does).

### Installed
Frontend: `idb-keyval`, `vite-plugin-pwa`; dev: `fake-indexeddb`. (Icons generated with Pillow, already present.)

### Bugs found and fixed
1. **Reloading the app offline logged the user out**: session restore treated "cannot reach the server" like "token rejected" and deleted the token. Found by the real-browser PWA test; fixed with a cached profile and sign-out only on 401/403; regression tests added.
2. **A colour token named `base` collided with Tailwind's `text-base` font-size class**, turning every `text-base` text near-white in light mode (and near-black in dark mode). Found by the real-browser contrast scan (1.09:1). Token renamed to `canvas`.
3. Amber badge text was too light in the light theme (4.08:1); darkened.
4. The QR image's `<title>` text made "first text match" in browser tests hidden; tests match the ID code exactly.

### Tests (all passing)
- Backend **179**: 12 new (batch replay processes oldest-first even when sent shuffled and raises the zone alert; retry is idempotent; single-fix duplicate; too-old rejected / future clamped; batch validation, roles, rate limit; 200-fix batch speed; late-panic labelling; cancel accidental panic and dashboard notified; cannot cancel after acknowledgement, after 10 min, someone else's, or a non-panic alert; trip and contacts; contacts empty after erasure).
- Frontend **173 vitest** (new: outbox 10, geometry 6, hold button 7, i18n 3, tracker 8, store/offline-session 10, tourist screens 25 incl. hold vs short press, offline panic then delivery on reconnect, status stepping to "help is on the way", cancel and refusal, offline banner, tab navigation, zone banners, settings, install prompt, Hindi, axe on all five tabs).
- **E2E 23 passed** in real Chromium. New: a real mouse press-and-hold (a quick tap sends nothing), the tourist's phone showing "control room has seen your request" after police acknowledge; **offline spec** (network off -> locations pile up -> panic saved with SMS fallback -> network back -> request and backlog delivered -> police see them -> cancel); **PWA spec against the production build** (manifest, icons, service worker activated; app shell opens with the network off; a signed-in tourist reopens the app and their ID card offline; logout deletes the cached API data). All five tourist tabs pass the real colour-contrast scan in light/dark, phone/desktop.
- Not covered: real phone GPS, the browser's actual install prompt (only the hook), background sync while the app is closed (the outbox flushes when the app is open or comes back online), web push.

---

## Phase 13 — Police dashboard v2 and analytics  (DONE, with one environment caveat)

### What was done
- **Backend**: queue filters (type, status, rule, ID-code search, date range, pagination via `paged=true`); assignment (`assignee_id`; whoever acknowledges owns it unless already assigned; only active police/admin can be assigned; `GET /dashboard/staff`); resolution outcomes (`resolved` / `false_alarm`, with acknowledged/resolved timestamps); `POST /alerts/bulk` (skips with reasons, duplicates processed once); `GET /dashboard/trail/{tourist_id}` (6-48 h, pseudonymous); incident notes and a merged **timeline** (alerts, staff actions, notes; no personal data); CSV export of alerts and of the audit log with spreadsheet-formula neutralisation (`csvutil.py`) and audit entries for exports; zone alerts record their zone. `GET /analytics/summary`: alerts per day by group, median time to acknowledge/resolve, per-detector genuine vs false-alarm share (the field precision signal the paper calls for), busiest zones, active tourists per day. Alembic `0005`.
- **Frontend** `/dashboard` rebuilt as an ops console: filters, queue with assignee/priority/relative time, bulk select + acknowledge, detail panel (workflow with outcome choice, assignment, trail replay slider on the map, case timeline and notes, personal details and e-FIR as before), map layer toggles, keyboard shortcuts (J/K, A, D, R, ignored while typing), sound plus desktop notification on a NEW panic only (opt-in, guarded), CSV export. `/analytics` with recharts (stacked bars, line, horizontal bars) using a palette validated with the dataviz validator (CVD dE >= 9, normal-vision dE >= 26 in both modes), a legend on every chart, and a **"View as table"** alternative for each.
- Audit page: CSV export and the new action names.

### Bugs found and fixed
1. **Out-of-order responses**: a slow earlier request could overwrite a newer filter result. Only the newest request now updates the screen (regression test).
2. Heading levels skipped (h1 -> h3) in the details panel; a horizontally scrolling table was not keyboard-focusable. Both found by axe.
3. Test mistakes: an analytics test measured times from module import instead of alert creation; E2E steps raced the server.

### Tests
- Backend: 17 new dashboard-v2 tests (filters, dates, ordering, assignment rules, resolution reasons, bulk, trail window/cap, notes/timeline, CSV escaping and audit, analytics numbers, staff list). Full run: all pass except the machine-speed benchmark below.
- Frontend **205 vitest** (new: dashboard 23, analytics 10, alerting 7); build clean.
- E2E **real Chromium**: new control-room spec (filter, open, trail, assign, acknowledge, note, dispatch, resolve as false alarm, bulk acknowledge, keyboard resolve, CSV download, analytics shows the 100% false-alarm share) and the earlier flows; `/analytics` and the new dashboard pass the colour-contrast scan in light/dark, phone/desktop (13/13 visual runs).

### Caveat (not hidden)
`test_lookup_time_under_100us_with_5000_zones` and the Table V benchmark test now measure about 138-200 us per fix on this laptop (70 us earlier in the project), even at 3% CPU load. The geo engine code has not changed since it measured 67-70 us, so this looks like the machine running slower (power/thermal state), not a regression. The thresholds were NOT loosened: those two tests currently fail here and should be re-run on a cooled or plugged-in machine.

---

## Phase 14 — Per-district calibration and zone tools  (DONE)

### Update to the Phase 13 caveat
The two timing tests that failed in Phase 13 now pass (219/219 backend tests in one run). The earlier slowness was the machine, not the code.

### What was done
- **Calibration parameters** (`detect/params.py`): R1 minutes; R2 still-minutes, distance and "anywhere" minutes; R3 distance and minutes; alert cool-down; geo-fence debounce `k`, buffer and warning ring; night hours. Defaults are the paper's values. Strict validation (bounds, whole numbers, unknown keys, R2 ordering).
- **Settings store** (`settings_store.py`, `SystemSettings` table, Alembic `0006`): admin-saved values stored as differences from the defaults, cached in memory; a corrupt row falls back to the paper's values so detection never stops. The detection service, geo engine (rebuilt on save), safety-score night window and cool-down state all read the live values; rules, feature windows and the evaluation harness take the parameters explicitly.
- **API** (admin only): `GET/PUT /api/admin/settings`, `POST /settings/reset`, `POST /settings/whatif` (dry run: rules on the same simulated matched and shifted days with your settings vs the paper's defaults, plus the zone-boundary false-alert rate; nothing is saved). Saves are audited with a before->after diff.
- **Zones**: `GET /api/zones/geojson` and all-or-nothing `POST /api/zones/import` (Polygon only, `[lon, lat]` order, same-name zones skipped, per-feature error messages). Zone editor now supports edit (PUT), duplicate, risk presets, undo-corner, export/import buttons and a delete confirmation.
- **Frontend** `/calibration` (admin): grouped sliders and number fields with the paper default shown, "changed" markers, inline range errors that block saving, preview comparison tables (better/worse badges), save, reset with confirmation.

### Tests (all passing)
- Backend **219** (new: parameter defaults/validation/merge; each rule reading its parameter; night window wrapping and same-day; API get/put/reset/audit, roles, corrupt-row fallback; **changing R1 changes when the drop-off alert fires; changing k/buffer changes zone alerts**; what-if is a dry run and slower thresholds show longer delays; looser thresholds cut false alerts on shifted days; GeoJSON round trip, all-or-nothing import and validation).
- Frontend **216 vitest** (new: calibration 8, zone editor 3); build clean.
- **E2E 25 passed** (real Chromium): admin enters an invalid value (blocked), previews, saves, sees the value persisted, resets, and exports GeoJSON from the zones page; the calibration page also passes the colour-contrast scan in light/dark, phone/desktop.
- Not covered: importing a real GeoJSON file in the browser (the file input is unit-tested only); calibrating from real field data (only simulated days exist).

---

## Bug hunt and self-service digital ID  (DONE)

### New: visitors create their own digital ID on the website (no office visit)
- **Backend** `POST /api/ledger/apply` (tourist): document number, dates (up to 90 days, not in the past), itinerary (at least the hotel), 1-5 emergency contacts, and an explicit declaration. Issues the same signed, salted-hash credential as an officer would; personal details are encrypted off-chain as before. Rate limited (5 attempts/hour) and audited (`self_issue_id`).
- **Trust level**: self-issued IDs are marked `self_declared` (the identity document was not checked by a person). Officers issue `officer`-level IDs; an officer can later press "Mark verified" after seeing the original document (`POST /tourists/{id}/verify-in-person`, audited). The level is shown to the visitor, on the public Verify page ("self-declared: ask to see the original document"), and in the officer's Tourists list. This is a deliberate trade-off: the website cannot check a passport, so it says so instead of pretending.
- **One document, one active ID**: a keyed hash (HMAC) of the normalised document number (case, spaces and dashes ignored) is kept so a second account cannot get a live ID for the same passport; this also applies to officer issuance and survives renewal. The hash is deleted when the personal data is erased and when an ID is revoked or expires the document is free again. Migration `0007`.
- **Frontend**: new visitors see "Get your digital ID" (document, dates, itinerary map, contacts, declaration) instead of an empty app; when it succeeds the home screen switches to the full safety dashboard with no reload. The hotel pin starts at the visitor's real GPS position (not a fixed demo location). Expired or revoked visitors see "Create a new digital ID".

### Bugs found and fixed
1. **Visitors whose ID had expired or been revoked could never get another one** (both the officer form and renew said "already has an ID", renew also fails once data is erased). A new ID is now allowed when the previous one is expired or revoked; the old itinerary is replaced.
2. **Renewing an ID did not register the document in the duplicate-document index**, so after a renewal a second account could reuse the passport. Fixed.
3. **Date bug for visitors ahead of UTC**: just after midnight in India the app sent yesterday's UTC date and the server answered "start date is in the past". The form now uses the local calendar date and the server tolerates a 2-day offset.
4. **Hotel pin defaulted to Shillong** for everyone, which would trigger route/inactivity alerts from minute one for visitors elsewhere. It now starts at the visitor's position.
5. Defensive: the new location lookup crashed when a browser lacked `getCurrentPosition`.
6. An older test reused one passport number for three tourists; the duplicate-document rule (correctly) refused it.

### Verification of the whole build
- **Crash finder** (`tests/test_no_server_errors.py`): calls all 72 API operations as signed-out, tourist, officer, police and admin users with empty, nonsense, oversized and missing-id inputs. **No server errors (5xx) anywhere.**
- **Upgrade check**: the new code was started against a copy of the real development database; migration ran, all main endpoints answered 200.
- **Browser sweep** (`e2e/sweep.spec.ts`): family link on/off, Hindi UI saved on the account, unknown URLs, session across reload, logout redirects, public verify page with garbage, hotel pin at a non-Shillong location, and creating/editing/duplicating/deleting zones by clicking the map. All worked.
- **Full journey in a real browser** (`e2e/self-service.spec.ts`): register -> create ID online with a map click -> dashboard appears -> ID card shows the self-declared notice -> public verify says valid + self-declared -> the visitor's location inside a zone raises a live alert for police -> a second account using the same passport written differently is refused -> an officer marks it verified -> the visitor's app shows "Verified by an officer".

### Final test counts
Backend **234**, frontend **223** unit tests, **27** end-to-end browser tests, build clean. (Backend 14 self-service tests incl. dates, duplicates, expiry, revocation, verification level, rate limit, renewal.)

### Honest limits
- Self-issued IDs are not identity-checked; police/check-posts see that flag. A real deployment could add online document verification (e.g. DigiLocker/Aadhaar e-KYC) as a later step; it needs government API access and is not built.
- Real phone GPS, camera QR scanning, SMS and push were not testable here.
