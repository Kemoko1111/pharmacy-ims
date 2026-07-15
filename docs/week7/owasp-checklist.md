# OWASP Top 10 (2021) Checklist — PharmaTrack

**COE 454 Week 7 deliverable.** Status keys: ✅ implemented · ⚠️ partial (gap noted) · ⛔ not applicable.
Every ✅ names the code that enforces it, so the panel can verify claims.

| # | Risk | Status | Where / how |
|---|---|---|---|
| A01 | Broken Access Control | ✅ | Single server-side `RolesGuard` matrix (`common/roles.guard.ts`); UI only hides what the server refuses. Cashier sales scoped to own+today in `SalesService.assertCanView`. Customers module P/M-only. Over-receipt and price changes role-gated in services, not just routes. e2e tests assert 403s. |
| A02 | Cryptographic Failures | ✅ | Argon2id password hashing (`@node-rs/argon2` defaults); refresh tokens stored as SHA-256 hashes; HTTPS enforced by Vercel/Railway platforms; no card data stored (cash/MoMo reference only). |
| A03 | Injection | ✅ | Prisma parameterized queries throughout; the few raw queries use tagged templates (`$queryRaw`) which bind parameters; `class-validator` DTOs with `forbidNonWhitelisted` reject unknown fields; CSV import parses with `csv-parse`, never string-splices SQL. |
| A04 | Insecure Design | ✅ | Money as integer pesewas (no float drift); stock mutations behind `FOR UPDATE` row locks in one transaction; append-only movement ledger; idempotent `clientSaleId` makes retries safe by design (ADR-006). |
| A05 | Security Misconfiguration | ✅ | `helmet()` security headers on the API; CORS restricted to the web origin via env; secrets only in platform env vars (`.env` gitignored); strict CSP + nosniff/referrer/permissions headers on the web app (`vercel.json`) — the theme bootstrap was externalized so `script-src 'self'` holds with no unsafe-inline. |
| A06 | Vulnerable & Outdated Components | ✅ | Current majors (NestJS 11, Prisma 6, React 18, Vite 6); `pnpm-lock.yaml` committed; pnpm 10 blocks unapproved postinstall scripts; CI runs `pnpm audit --audit-level high` on every PR. |
| A07 | Identification & Authentication Failures | ✅ | 15-min JWTs + rotating 12-h refresh tokens with family revocation on reuse (`auth.service.ts`); 5-failure lockout (423) with audit event; uniform 401 message + constant-time compare defeats username enumeration; login throttled 5/min/IP; password policy enforced in DTOs; reset-password revokes all sessions. |
| A08 | Software & Data Integrity Failures | ⚠️ | CI runs lint+tests on every PR; branch protection on `main` planned per project plan §6. **Gap:** service-worker update flow uses `registerType: 'prompt'` (good) but PWA asset integrity relies on Workbox hashes only. |
| A09 | Security Logging & Monitoring Failures | ✅ | `audit_logs` table with before/after diffs for auth events (login, lockout, token reuse), price changes, voids, returns, adjustments, settings changes; Pino structured request logs; negative-stock exceptions surfaced as notifications, never silent. |
| A10 | Server-Side Request Forgery | ⛔ | The API makes no user-controlled outbound requests (only fixed-URL Africa's Talking calls with server-side credentials). |

## Known accepted risks (documented for the panel)

1. **Tokens in `localStorage`** — vulnerable to XSS exfiltration; accepted for MVP because
   the PWA needs offline token access, React escapes rendered content by default, and no
   third-party scripts are loaded. Mitigation path: move refresh token to an httpOnly
   cookie post-course.
2. **Offline oversell** — two offline tills can both sell the last stock; deliberately
   surfaced as a `NEG_STOCK_EXCEPTION` Manager alert rather than hidden (ADR-006).
3. **QB-IMPORT placeholder expiries** — imported stock carries a flagged 6-month
   placeholder expiry until the pharmacist enters real batches; the import raises a
   review notification and FEFO is not trusted for those batches.

## Pre-Demo-Day hardening tasks

- [x] Add CSP header to the web app (Vercel `headers` config)
- [x] `pnpm audit` job in CI
- [x] Nightly `pg_dump` workflow (activates once `PROD_DATABASE_URL` secret is set)
- [ ] Rotate the demo credentials; disable the seeded `admin` account in prod
- [ ] Adjust CSP `connect-src` to the final API domain after the Railway deploy
- [ ] Verify Railway Postgres is not publicly reachable (private networking)
- [ ] Run this checklist against the live URLs, screenshot evidence for the report
