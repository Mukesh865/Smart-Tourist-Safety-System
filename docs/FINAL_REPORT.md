# Smart Tourist Safety Monitoring and Incident Response System

**Using AI, Geo-Fencing and a Blockchain-Based Digital ID**

Final Year Project Report
Ajay Kumar Garg Engineering College (AKGEC), Ghaziabad, India
Team: Abhijit Shukla, Mukesh Kumar Singh, Aditya Singh
Project guide: Mr. Manoj Kumar Sharma (CSE Department)

---

## 1. Executive Summary

Tourists in hill, forest and border districts travel through unfamiliar terrain with patchy mobile coverage. When one of them goes missing, the police usually learn of it hours later and have no trustworthy record of who the person was or where they meant to go.

This project is a working website that closes that gap. A visitor creates a **digital tourist ID** online in a few minutes. Their phone shares location with a safety server, which warns them about dangerous zones and raises an alert when their movement looks wrong. A **panic button** reaches the control room even with no internet. Police and tourism staff see everything live on a dashboard, open personal details only for an active case, and generate a draft e-FIR with one click.

The system is based on our IEEE-style research paper, which measured three risky building blocks (geo-fencing, anomaly detection and a ledger-based ID) in simulation. This project turns that prototype into a complete, tested application with three user roles, an admin console, an installable offline-capable phone app and an automated test suite.

**At a glance**

| Item | Value |
|---|---|
| Users served | Tourists, issuing officers, police / control room, administrators |
| Backend | Python 3.13, FastAPI, SQLite (PostgreSQL-ready) |
| Frontend | React 18, TypeScript, Tailwind CSS, Leaflet maps |
| API size | 72 operations plus a live WebSocket feed |
| Automated tests | 234 backend, 223 frontend, 27 real-browser end-to-end |
| Languages | English and Hindi |
| Status | All planned features built and tested; field trials not yet done |

---

## 2. The Problem

### 2.1 What goes wrong today
1. **Late discovery.** A missed call to a hotel, a worried relative and a police complaint the next day. In remote areas, hours or days pass before anyone knows.
2. **No trusted record.** Officers rebuild a visitor's identity, itinerary and last position from scattered hotel registers and call records.
3. **Alerts that cannot be trusted.** Naive geo-fences fire false alarms when a walker passes near a boundary, because GPS error drifts. Naive anomaly detectors either flood the control room or stay silent.
4. **Privacy risk.** A "blockchain ID" that stores passport numbers on an append-only chain breaks data-protection law (India's DPDP Act, 2023), because the data cannot be erased.
5. **Access barrier.** Requiring every visitor to queue at an office to get registered discourages use.

### 2.2 Who is affected
Tourists and their families, district tourism departments, local police and control rooms, hotels and trek operators.

---

## 3. Objectives

1. Give every visitor a tamper-evident, privacy-preserving digital ID that anyone can verify, even offline.
2. Warn visitors before they enter danger zones, without drowning them in false alerts.
3. Detect drop-off, inactivity and route deviation early, using the visitor's own itinerary.
4. Reach the control room in seconds when a visitor presses panic, even without data.
5. Give staff one place to see, triage, assign and close incidents, with every sensitive action audited.
6. Let visitors get their ID online with **no physical visit**.
7. Measure the system honestly against limits fixed before testing.

---

## 4. System Overview

### 4.1 Four tiers (from the paper's architecture)
1. **Digital ID tier.** An issuer creates a salted, hashed record, groups records into signed blocks and gives the visitor a QR code. Personal data is stored encrypted, off the ledger.
2. **Phone app tier.** Live location, zone warnings, a panic button, a safety score and family sharing.
3. **Detection tier.** A geo-fence service and a movement-anomaly service consume the location stream.
4. **Dashboard tier.** Live alerts, maps, incident workflow and e-FIR drafting for staff.

### 4.2 Roles

| Role | What they do |
|---|---|
| Tourist | Creates an ID, shares location, receives warnings, presses panic, shares a live link with family |
| Issuing officer | Issues IDs in person, verifies self-declared IDs, extends IDs, edits itineraries |
| Police / control room | Watches alerts, assigns and resolves them, opens case details, downloads e-FIR drafts, manages zones |
| Administrator | Manages accounts, calibrates detection thresholds, audits actions, checks ledger integrity |

### 4.3 How a typical incident flows
1. The visitor creates an ID online and starts a trip.
2. The phone sends a location every 15 s near risk zones and every 60 s elsewhere.
3. The visitor stops moving 1 km from any planned stop for 40 minutes.
4. The detection service raises an *inactivity* alert, scored for priority by the machine-learning ranker.
5. The alert appears on every open police dashboard instantly, with a sound for panics.
6. An officer acknowledges it, which opens an incident and assigns it to them.
7. They replay the visitor's last six hours of track, add notes, and open personal details (logged).
8. They dispatch help, close the incident (genuine or false alarm) and download the draft e-FIR.

---

## 5. Technology Stack

### 5.1 Backend
| Area | Technology |
|---|---|
| Language / framework | Python 3.13, FastAPI, Uvicorn |
| Database | SQLite for development (SQLModel / SQLAlchemy); migrations with Alembic (7 revisions); PostgreSQL-compatible |
| Authentication | JWT with a per-user token version (so disabling an account or changing a password ends old sessions immediately), bcrypt password hashes |
| Cryptography | `cryptography` library: ECDSA P-256 signatures, SHA-256, Fernet encryption, HMAC |
| Machine learning | scikit-learn Isolation Forest (200 trees) with NumPy |
| Real time | WebSockets for the live alert feed |
| Documents | ReportLab for the draft e-FIR PDF, `qrcode` for QR codes |
| Safety | In-memory rate limiter, security headers, strict input validation |

### 5.2 Frontend
| Area | Technology |
|---|---|
| Framework | React 18, TypeScript, Vite |
| Styling | Tailwind CSS with a design-token system, automatic light and dark themes |
| Maps | Leaflet, react-leaflet, leaflet.heat (risk heat map) |
| State / data | Zustand, Axios |
| Charts | Recharts (colours validated for colour-blind readers) |
| Offline / PWA | vite-plugin-pwa (service worker), IndexedDB outbox (idb-keyval) |
| QR | qrcode.react (display), html5-qrcode (camera scan) |

### 5.3 Testing and quality tools
pytest, Vitest, Testing Library, **Playwright** (real Chromium), **axe-core** (accessibility, including real colour-contrast checks), fake-indexeddb.

---

## 6. Functionalities

### 6.1 Digital tourist ID (blockchain-style ledger)
- Each private field (document number, itinerary, contacts) is hashed with a fresh random salt; only the hashes go on the ledger.
- Records are grouped into blocks. Each block has a Merkle root, links to the previous block and is signed with ECDSA P-256.
- The QR code carries the record, its Merkle path and the signed header (about 450 bytes for a single ID; 854 bytes when 256 IDs share a block, well under the QR limit of 2,953).
- **Offline verification:** a check-post recomputes the root, checks the signature and the validity dates. No internet or personal data is needed.
- **Revocation list:** a signed, hash-chained list lets police cancel a lost or abused ID instantly. It is public so check-posts can mirror it.
- **Renew / extend:** issues a new ID with the same verified details and marks the old one as superseded.
- **Erasure:** personal data is deleted after the visit ends; the ledger keeps only hashes that can no longer be linked to anyone.
- **Ledger explorer:** staff can inspect blocks (hashes only), see integrity badges and revoke IDs.
- **One document, one active ID:** a keyed hash of the document number blocks duplicates without storing the number.

### 6.2 Self-service ID, no office visit
A visitor registers, enters a document number, trip dates, a hotel and stops on a map, and emergency contacts, confirms the declaration, and receives a working ID immediately. Such IDs are labelled **self-declared** everywhere (visitor's app, public verify page, officer's list) until an officer sees the original document and presses "Mark verified". Expired or revoked visitors can create a new ID the same way.

### 6.3 Geo-fencing
- Risk zones are polygons with a risk weight, optionally "no-entry" with a warning ring.
- A 1 km grid index checks a GPS fix against thousands of zones in microseconds.
- An entry alert needs **3 consecutive fixes at least 20 m inside** a zone. This buffer-and-debounce rule comes from the paper's finding that GPS error drifts slowly, so debouncing alone does not remove false alerts.
- Zone editor: draw by clicking a map, edit, duplicate, risk presets, undo, delete with confirmation, GeoJSON import and export.

### 6.4 Movement anomaly detection
Every minute, six features are computed per visitor. Three itinerary-aware rules raise alerts:
- **R1** no location for more than 20 minutes (signal drop-off)
- **R2** still for more than 40 minutes and more than 200 m from any planned stop, or 150 minutes anywhere but the hotel (inactivity)
- **R3** more than 1 km from the planned route for 10 minutes (deviation)

An Isolation Forest does **not** raise alerts on its own; it only gives each alert a priority score. This follows the paper's conclusion that learned detectors without itinerary knowledge miss inactivity and break when behaviour changes. A 60-minute cool-down prevents repeated alerts.

### 6.5 Per-district calibration
Administrators can tune every threshold (rules, cool-down, geo-fence debounce and buffer, night hours) with sliders that show the paper's default. A **preview** re-runs the rules on simulated days and compares the effect with the defaults before anything is saved. All changes are audited.

### 6.6 Visitor phone app (installable, works offline)
- Five tabs: Home, Map, Safety, ID and Settings. Hindi and English.
- **Home:** safety score ring, status (safe, near a risk area, inside one), next planned stop.
- **Panic button:** press-and-hold for 1.5 seconds so a pocket press cannot trigger it; keyboard and confirmation alternatives for accessibility; shows delivery status (saved, sent, seen by the control room, help on the way); can be cancelled within minutes if it was a mistake and nobody has acknowledged it.
- **Offline behaviour:** locations and panic requests are saved on the phone and replayed oldest-first when the connection returns; an SMS hand-off link is offered when data is down.
- **Safety score:** `S = 100 (1 - 0.5 Z - 0.2 N - 0.3 A)` from nearby zone risk, night time and recent anomaly, shown with a breakdown.
- **Family live view:** an opt-in link that shows only a first name and the last position, revocable at any time.
- **Installable PWA** with a service worker; cached data is wiped on logout.

### 6.7 Police and control-room dashboard
- Live alert queue (panic first, then priority), with filters, search by ID code, pagination and bulk acknowledge.
- Map with zones, visitor positions, clusters, a heat map and layer toggles.
- Alert panel: workflow (open, acknowledged, dispatched, resolved as genuine or false alarm), assignment to staff, a six-hour **trail replay** slider, incident timeline and notes.
- Personal details open **only for an active incident** and every access is logged. Draft e-FIR PDF generated from the ID record, itinerary, track and alert log.
- Sound and desktop notification for new panic alerts, keyboard shortcuts (J, K, A, D, R), CSV export.

### 6.8 Analytics
Alerts per day by type, active visitors, median time to acknowledge and resolve, busiest zones, and a **detector accuracy table** showing the false-alarm share of each alert type as judged by staff in the field. Every chart has a "view as table" alternative.

### 6.9 Administration and security
- User list with search and role filters, create staff, change roles, disable accounts, reset passwords (temporary password shown once).
- Safeguards: nobody can lock out the last administrator or themselves.
- Audit log with filters and CSV export; system status; ledger chain verification; erase-expired-data with confirmation.
- Password change and "sign out of all devices"; disabled or changed accounts lose access immediately, including live connections.
- Rate limits on login, registration, verification, panic, location and ID creation; security headers; the server refuses to start in production with default secrets.

### 6.10 Evaluation page
The paper's "limits set before testing" table is measured live on the running system. Rows that need real users (battery, usability score) are honestly shown as "next stage".

---

## 7. Key Problems Solved Right Now

| Problem | How the system addresses it |
|---|---|
| Police learn of a missing tourist hours late | Movement rules raise an alert within about 20 to 40 minutes; panic reaches the dashboard instantly |
| No trusted record of identity or itinerary | Signed digital ID plus a stored itinerary; draft e-FIR pre-filled from them |
| Geo-fence false alarms from GPS drift | Buffer (20 m) plus debounce (3 fixes); measured below 0.01 false alerts per km in simulation |
| Alert floods or silence from AI | Rules raise alerts, the learned model only ranks them; thresholds tunable per district with a preview |
| Privacy and data-protection law | No personal data on the ledger or in dashboard overviews; encrypted store; erasure after the visit; audited access |
| Forged or stolen IDs | Signature plus Merkle proof, a signed revocation list, one-active-ID-per-document |
| Visitors must queue at an office | Online self-service ID creation |
| No signal in remote areas | Offline outbox, SMS fallback, offline-capable installable app |
| Accidental panic presses | Press-and-hold, cancel window, clear delivery status |
| Staff overload | Priority ranking, bulk actions, assignment, keyboard shortcuts, analytics on false alarms |
| Misuse of staff access | Role-based access, per-incident data unlock, full audit log, immediate account revocation |

---

## 8. Results and Evaluation

### 8.1 Measured against the paper's pre-set limits (this laptop, synthetic data)

| Measure | Limit | Result |
|---|---|---|
| Personal data on the ledger | none | none (checked on live data) |
| ID check time | under 1,000 microseconds | about 100 microseconds |
| Geo-fence lookup per fix (5,000 zones) | under 100 microseconds | about 70 microseconds on this machine (the paper measured 8 on an Apple M2) |
| False geo-fence alerts per km | under 0.01 | 0 with the 20 m buffer |
| Entry alert delay | under 60 seconds | about 52 seconds median |
| Panic alert to dashboard (server side) | under 10 seconds | well under 1 second |
| Rules recall on matched days | at least 95% | 99.3% with 0 false alerts per 100 days |
| False anomaly alerts when behaviour is wider than assumed | at most 5 per 100 days | **52 per 100 days: limit missed**, as in the paper |

### 8.2 Findings that match the paper
- Rules are near-perfect when behaviour matches their assumptions, but their false alerts rise sharply when it does not, which is why thresholds must be set per district.
- The Isolation Forest finds only about 2% of inactivity cases (paper: 3%) and is faster on drop-offs.
- Debouncing alone does not remove false geo-fence alerts under time-correlated GPS error; a distance buffer does.

### 8.3 Where our numbers differ (stated honestly)
- The forest finds only about 3% of route deviations (paper: 84.5%), so its overall recall is lower.
- Rule false alerts on the widened-behaviour set are about twice the paper's.
- Our lookup is slower than the paper's because it runs in Python on a Windows laptop.

### 8.4 Software quality
- **234** backend tests, **223** frontend tests and **27** end-to-end tests in a real browser, all passing.
- A crash-finder test calls all 72 API operations as every role with hostile input: no server errors.
- Every page passes automated accessibility checks, including colour contrast, in light and dark themes on phone and desktop sizes.
- Tampering tests: altered records, a flipped header bit and a forged re-rooted block were all detected in every trial.

---

## 9. Bugs Found and Fixed During Development

Testing in a real browser and against real data found problems that unit tests alone missed. Examples:
- Reloading the app while offline silently signed the user out.
- A colour-name clash made some text almost invisible in light mode (found by the contrast scan).
- Visitors whose ID had expired could never get a new one.
- Renewing an ID skipped the duplicate-document check.
- A date bug rejected valid requests from visitors just after midnight in India.
- The hotel pin defaulted to Shillong for everyone, which would trigger false alerts elsewhere.
- Demo scenarios polluted each other when run back to back.
- A slow, older server response could overwrite a newer filter result on the dashboard.

Each fix has a regression test, and the full history is in `docs/PHASE_LOG.md`.

---

## 10. Limitations

1. **All movement data is synthetic.** Results show how the methods behave, not how they will perform in a real district.
2. **Self-declared IDs are not identity-checked.** The website cannot verify a passport. This is labelled everywhere and an officer can verify later.
3. **The ledger is a single-authority signed hash chain on one server**, not a multi-organisation network such as Hyperledger Fabric.
4. **Web app, not a native Android app.** Real GPS accuracy, battery use and background behaviour on phones are untested. The SMS fallback is a hand-off link, not a gateway.
5. **No real dispatch integration.** "Dispatch" records a status only.
6. **Not yet measured in the field:** battery use, real-network panic latency and usability score.
7. **Single-process deployment.** Rate limits and debounce counters are in memory; several server copies would need a shared store.
8. **Deployment packaging is not finished** (Docker, automated CI pipeline and production logging are still to do).
9. Map tiles come from OpenStreetMap and need internet access.

---

## 11. Future Features and Upcoming Advancements

### 11.1 Near term (next release)
- Docker images and a docker-compose setup with PostgreSQL; an automated CI pipeline running all tests.
- Structured logging, request IDs and a deeper health check.
- Real-time reconnect with catch-up after the dashboard loses connection.
- More interface languages (the app already supports adding them); a target of ten or more Indian languages.

### 11.2 Identity and trust
- **Online document verification** through government services (for example DigiLocker or Aadhaar e-KYC) so self-service IDs can be verified without a visit.
- Face match against the document photo for officer-assisted checks.
- Verifiable Credentials and Decentralised Identifier formats (W3C) for interoperability with other systems.

### 11.3 Ledger
- A real multi-organisation **Hyperledger Fabric** network (tourism department, police, state authorities) with consensus.
- Signed revocation-list mirroring for check-posts with no connectivity at all.

### 11.4 Mobile and devices
- Native **Android and iOS apps** with background tracking, battery-aware sampling and push notifications.
- A real SMS or satellite messaging gateway for the panic fallback.
- **Smart-band and IoT integration** for caves, forests and areas with no mobile coverage (long-range radio).
- A dedicated low-power "tourist tag" for trekking groups.

### 11.5 Intelligence
- **Per-district calibration from real, consented tracks** (the paper's top recommendation), replacing simulated tuning.
- Learned models that understand itineraries and terrain (slope, weather, trail maps) to predict risk, still used to rank rather than to raise alerts alone.
- Weather and disaster feeds that turn zones on and off automatically (landslide warnings, floods, curfews).
- Group tracking for tour operators and a "buddy" mode for solo trekkers.
- Smarter false-alarm learning from how staff close alerts (the analytics page already collects this signal).

### 11.6 Operations and governance
- Integration with police CAD / dispatch systems and hotel registers.
- Escalation rules (for example, auto-notify a senior officer if a panic is not acknowledged in two minutes).
- Multi-district administration with delegated admins and data residency controls.
- Formal privacy impact assessment and external security audit before any public launch.
- Field trials as laid out in the paper's plan: battery use, real-network delivery, panic reach over 4G, 2G and SMS, and the standard usability scale.

### 11.7 Roadmap summary

| Stage | Focus |
|---|---|
| Next | Packaging, CI, logging, more languages |
| Then | Native apps, SMS gateway, government identity verification |
| Later | Fabric network, IoT bands, real-data calibration, field trials with volunteers |
| Beyond | Predictive risk models, multi-state rollout, dispatch integration |

---

## 12. Conclusion

A tourist-safety system is only as useful as its alerts are trustworthy. This project shows, with measurements, where trust breaks: GPS drift defeats simple debouncing, learned detectors without itinerary knowledge miss inactivity, and rule thresholds must match local behaviour. It then builds a complete product that is designed around those findings rather than ignoring them: a buffer and debounce for zones, itinerary-aware rules as the primary detector, a learned model that only ranks, administrator-tunable thresholds with a preview, and analytics that measure false alarms in the field.

It also treats privacy as a design requirement. The ledger holds only salted hashes, personal data is encrypted, opened only for an active case, logged, and erased after the visit, which keeps the design compatible with India's data-protection law.

The result is a working, thoroughly tested website that lets a visitor create a verifiable digital ID without visiting an office, stay protected even when the network drops, and be found faster when something goes wrong, while giving staff a clear, auditable way to respond. The main remaining step is exactly the one the paper identifies: field trials with real visitors in a real district to calibrate thresholds and measure battery, latency and usability.

---

## Appendix A. Where Things Are

| Item | Location |
|---|---|
| Backend code | `backend/app/` (ledger, geo, detect, routers) |
| Frontend code | `frontend/src/` (pages, components, offline, ui) |
| Tests | `backend/tests/`, `frontend/src/**/*.test.*`, `frontend/e2e/` |
| Phase-by-phase record | `docs/PHASE_LOG.md` |
| Viva talking points | `docs/VIVA_NOTES.md` |
| Run instructions | `README.md` and `run_dev.ps1` |

## Appendix B. Main Screens

| Screen | Audience | Purpose |
|---|---|---|
| Login / Register | Everyone | Account access |
| Get your digital ID | Tourist | Self-service ID creation |
| Home, Map, Safety, ID, Settings | Tourist | Phone app |
| Public Verify | Check-posts, anyone | Scan or paste a QR |
| Family link | Relatives | Live location when the visitor opts in |
| Issue ID wizard, Tourists | Officer | In-person issuing, verification, extension, itinerary editing |
| Police dashboard | Police | Live queue, map, case panel |
| Analytics | Police, admin | Workload and detector accuracy |
| Zones, Ledger explorer | Police, admin | Risk areas, ledger and revocation list |
| Calibration, Administration, Evaluation | Admin | Thresholds, accounts, audit, paper-limit measurements |

## Appendix C. Demo Accounts (development only)

Admin `admin@tourist.local` / `Admin@12345`. Demo tourists `demo1..3@tourist.local` / `Demo@12345` after pressing "Seed demo data" on the police dashboard. Change all of these before any real deployment; the server refuses to start in production with the defaults.
