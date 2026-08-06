# Load test results — read-heavy POS profile

Week 7 deliverable (project plan §Gantt, "Load test k6 + OWASP + gap report").
Script: `scripts/load/k6-pos.js`. Tool: k6 v2.1.0.

## What was run

```
k6 run scripts/load/k6-pos.js          # BASE defaults to http://localhost:3000
```

Ramping-VU profile, 4 m 30 s: 0→20 VUs over 30 s, hold 20 for 2 min, ramp to 50,
hold 50 for 1 min, ramp down. Each iteration does a catalogue search, a barcode
lookup and a health check; one in five also pulls the daily dashboard. Sales
posting (`-e SALES=true`) was **not** enabled — this is the read profile.

Thresholds come from `api-schema.md`: product search p95 < 300 ms, overall p95
< 800 ms, error rate < 1 %.

## Result — 2026-08-06, all thresholds met

| Metric | Target | Measured |
|---|---|---|
| Product search p95 | < 300 ms | **15 ms** |
| Product search avg / median / max | — | 9.29 ms / 8.73 ms / 51.12 ms |
| All requests p95 | < 800 ms | **12.13 ms** |
| Request failure rate | < 1 % | **0.00 %** (0 of 15,726) |
| Checks passed | — | 4,909 / 4,909 |
| Throughput | — | 58.0 req/s, 18.1 iterations/s |
| Peak concurrency | — | 50 VUs |

Data set: the standard seed — 26 products, 29 batches, one branch.

## What this run does and does not show

It exercises the **application and its queries**, not the deployment. The API,
the database and the load generator all ran on one developer laptop
(Apple silicon, PostgreSQL 17 in Docker), so the numbers carry no network
latency, no Render cold start, no Neon connection limit and no contention from
other tenants. Read them as "the query plans and the Nest request path are
nowhere near the budget" — roughly a twentieth of it — rather than as a
prediction of what a till in the shop will feel.

Two further caveats:

- Login throttling was disabled for the run (`THROTTLE_DISABLED=true`). The
  script authenticates once in `setup()`, but the limit is 5 logins/min/IP
  (OWASP A07), and a load generator sharing one IP trips it immediately. Any run
  against a throttled environment has to account for that rather than treat the
  429s as failures.
- 26 products is a seed catalogue, not a real one. Search cost grows with the
  catalogue, so this says little about a shop carrying a few thousand lines.

**A run against the live Render API is still outstanding.** It needs the
client's agreement and an off-hours window: production is a free Render instance
in front of the client's real Neon database, 50 VUs is far more than that tier is
sized for, and the authentication throttle applies there. That run is the one
that answers "will it hold up in the shop"; this one answers "is the code the
bottleneck", and it is not.
