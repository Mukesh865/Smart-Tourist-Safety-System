# Viva notes: what to say and what to be honest about

## One-minute summary
A tourist gets a **digital ID** at the entry point. The ledger stores only **salted hashes**; personal data sits
encrypted off-chain and is erased after the visit. The tourist app sends GPS fixes; the server raises **geo-fence**
alerts (with a buffer and debounce that survive GPS drift) and **movement alerts** (itinerary-aware rules). Police see
alerts live, open personal details **only for an active incident** (audited), and get a **draft e-FIR**.

## Why each design choice (from the paper)
- **Buffer b = 4 sigma and k = 3**: GPS error is time-correlated (Gauss-Markov), so debouncing alone removes only part of
  the false alerts; distance from the edge is what works. Reproduced in `tests/test_geo_engine.py`.
- **Rules raise alerts, Isolation Forest only ranks**: the forest has no itinerary knowledge and misses inactivity (we measured 2 %,
  paper 3 %), but is faster on drop-off. Rules' false alerts depend on local thresholds (0 on matched days, 52 per 100 days on shifted).
- **Merkle blocks + ECDSA, salted commitments**: offline verification in ~100 microseconds, ~850-byte QR, nothing personal on the chain,
  so erasure under DPDP Act 2023 is possible. Tamper tests: record / header bit / re-rooted block, all detected.

## Where our numbers differ from the paper (say this before the examiner finds it)
| Item | Paper | Ours | Reason |
|---|---|---|---|
| Forest recall on deviation | 84.5 % | about 3 % | Isolation Forest does not extrapolate beyond its training range; unknown implementation differences |
| Rule false alerts, shifted days | 27 / 100 days | 52 / 100 days | our shifted simulator is probably harsher |
| Geo lookup, 5,000 zones | 8 us | about 70 us | pure Python on a Windows laptop vs the paper's M2 |
| QR payload at 256 IDs/block | 743 B | 845 B | JSON + base64 instead of a binary encoding |
| Each issued ID | blocks of 256 | its own block (1 ID) | so the tourist gets the QR immediately; code supports any block size |

## Likely questions
- *Is it a real blockchain?* A permissioned, hash-chained, signed ledger with one authority. Not multi-party consensus; Fabric is future work.
- *Is the AI trained on real data?* No. Synthetic trajectories only; no public dataset of tourist incidents exists. Calibration needs consented field tracks.
- *Is the safety score validated?* No. Weights are the paper's starting point and are not calibrated.
- *What about privacy?* No PII on the ledger or in the dashboard overview; PII opens per incident, every access is in the audit log; family sharing is opt-in and revocable.
- *What is not done?* Android app, real SMS/dispatch integration, offline PWA, field trials (battery, SUS, real latency).
- *Did you find bugs while building?* Yes, e.g. a rule fired on the very first fix; demo scenarios polluted each other (found only by a live run); a lookup too slow until bounding-box rejection was added. All are in `docs/PHASE_LOG.md`.
