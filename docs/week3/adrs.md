# Architecture Decision Records

**COE 454 — Week 3 Deliverable 1 (min 5 ADRs; format per brief §4.3.1)**
**Owner:** Backend Lead · Status key: Proposed / Accepted / Superseded

---

## ADR-001: Modular monolith, not microservices

**Status:** Accepted

**Context.** The brief's Weeks 7–8 require redesigning for thousands of users, which
tempts teams toward microservices from day one. We have 3–4 part-time implementers, six
weeks to a client-accepted MVP, one pharmacy, and one database. The client requirement
list spans many domains (auth, catalogue, inventory, purchasing, POS, reporting, audit),
which need clear boundaries regardless of deployment shape.

**Decision.** Build a single deployable NestJS application organized into explicit
modules with enforced boundaries:

| Module | Owns (DB tables) | Depends on |
|---|---|---|
| `auth` | refresh_tokens | users |
| `users` | users | — |
| `catalog` | products, categories, product_units, barcodes | — |
| `inventory` | batches, stock_movements, stock_adjustments | catalog |
| `suppliers` | suppliers | — |
| `purchasing` | purchase_orders, purchase_order_items, goods_receipts | suppliers, catalog, inventory |
| `sales` (incl. POS + sync) | sales, sale_items, payments, sale_returns | catalog, inventory, customers |
| `customers` | customers | — |
| `reporting` | (read-only views) | read models of all |
| `notifications` | notifications | inventory, settings |
| `audit` | audit_logs | (subscribed to all via events) |
| `settings` | settings | — |

Rules: modules communicate through exported service interfaces or in-process domain
events (`SaleCompleted`, `StockReceived`) — never by importing another module's
repository or touching its tables. Each module owns its migrations for its tables.

**Consequences.** *Easier:* one deploy, one DB transaction across sale + stock deduction
(critical for NFR-05), simple local dev for all 7 members, cheap hosting. Module
boundaries give us the seams to extract services in Week 8's scaling exercise — on paper
or in code. *Harder:* discipline is on us (an ESLint `import/no-restricted-paths` rule
enforces the boundaries); a single runtime means one noisy module can affect all (mitigated
by queueing report generation).

---

## ADR-002: Frontend — React 18 + TypeScript + Vite, as a PWA

**Status:** Accepted

**Context.** Needs: a fast keyboard-driven POS, an owner dashboard usable on a phone over
3G, offline capability (US-08), and skills the team already has. Course requires
responsive + mobile-3G operation. Alternatives considered: Next.js (SSR adds hosting and
mental overhead we don't need for an authenticated app), Angular (steeper for the team),
Flutter (no team experience, complicates barcode-wedge input and browser printing),
Electron desktop (fails the course's public-URL and mobile requirements).

**Decision.** React 18 + TypeScript on Vite, styled with Tailwind CSS; TanStack Query
for server state; Zustand for the POS cart; `vite-plugin-pwa` (Workbox) for
installability and offline caching; Dexie (IndexedDB) for the offline sale queue and
cached catalogue.

**Consequences.** *Easier:* biggest ecosystem and team familiarity; Vite dev speed; PWA
gives the till an app-like fullscreen experience and offline shell for free; one codebase
serves till, phone, and laptop. *Harder:* client-side-only rendering means we must manage
bundle size for 3G (route-level code splitting, no heavy UI kits); PWA cache
invalidation needs care (versioned service worker, "update available" toast).

---

## ADR-003: Backend — Node.js 22 + NestJS

**Status:** Accepted

**Context.** The modular monolith (ADR-001) needs a framework with first-class module
boundaries, dependency injection, guards/interceptors for RBAC and audit, and validation
layers — in a language the whole team can read. Alternatives: Express (no structure —
boundaries would be convention only), Django (Python; strong admin but team is
JS-centric and we'd split languages across the stack), Spring Boot (heavyweight for the
team's experience), Laravel (no team experience).

**Decision.** NestJS on Node.js 22 LTS. DTOs validated with `class-validator`; global
exception filter for consistent error envelopes; `@Roles()` guard for RBAC; interceptor
publishing audit events; `@nestjs/schedule` for cron jobs (expiry scan, alert digest);
Pino structured logging.

**Consequences.** *Easier:* NestJS modules map 1:1 to our architecture modules; DI makes
the repository pattern and testing natural (Jest + Supertest for the Week 4 test
requirement); TypeScript types shared end-to-end with the frontend via a `shared`
package. *Harder:* NestJS has learning-curve ceremony (decorators, providers) — mitigated
by scaffolding one exemplar module (`catalog`) in Week 3 that the team copies.

---

## ADR-004: Database — PostgreSQL 16 with Prisma ORM

**Status:** Accepted

**Context.** Inventory correctness is the product. We need real foreign keys, CHECK
constraints, atomic multi-row transactions (sale + movements + batch deduction),
row-level locking to prevent overselling a batch, and free managed hosting. Alternatives:
MySQL (viable, fewer team-relevant features, weaker CHECK history), SQLite (perfect
locally, but the hosted API needs concurrent writers), MongoDB (document model fights
relational stock math; transactions exist but model mismatch), Supabase (attractive
BaaS, but course expects us to own auth and API design — we use plain Postgres and keep
Supabase as a fallback host).

**Decision.** PostgreSQL 16, accessed through Prisma. Money stored as `NUMERIC(12,2)`
(GHS); quantities as integers in the product's base unit. Serializable transaction (or
`SELECT … FOR UPDATE` on batches) around stock deduction.

**Consequences.** *Easier:* constraints enforce invariants even if app code slips
(NFR-05); Prisma migrations give the team a reviewable schema history; Railway offers
managed Postgres with the API. *Harder:* Prisma hides some SQL — the two reporting
queries that need window functions/CTEs are written as raw SQL views (`reporting`
module); base-unit integer arithmetic pushes unit-conversion logic into one service
(`catalog.UnitConverter`) which must be well-tested.

---

## ADR-005: Authentication — JWT access + rotating refresh tokens, server-enforced RBAC

**Status:** Accepted

**Context.** Course Sprint 1 mandates JWT issuance/validation and protected routes. We
also need: five roles (Admin, Manager, Pharmacist, Inventory Officer, Cashier), audit
attribution per user (BR-06), a 12-hour shift session that survives brief network loss,
and offline-queued sales that can still be attributed. Alternatives: server sessions
(simpler revocation, but awkward across the PWA offline window and the course names
JWT), Auth0/Clerk (external dependency, free-tier limits, and hides the learning the
course grades).

**Decision.** Argon2id password hashing. On login: 15-minute JWT access token (contains
`sub`, `role`) + 12-hour refresh token, rotated on every use, stored hashed in
`refresh_tokens` with device label and revocation support. Roles are a Postgres enum on
`users`; permissions are enforced in a single `RolesGuard` matrix on the server — the UI
merely hides what the server would refuse. Rate limiting on `/auth/login`
(`@nestjs/throttler`) implements US-01 lockout with audit events.

**Consequences.** *Easier:* stateless access checks; refresh rotation limits stolen-token
lifetime; offline sales are queued with the user id and validated on sync. *Harder:* we
own lockout, rotation, and revocation logic (tests required); if a cashier's 12-h refresh
expires mid-outage, queued sales sync after re-login (queue is keyed to user, not token —
by design).

---

## ADR-006: Offline strategy — cached catalogue + append-only offline sales queue (not full sync)

**Status:** Accepted

**Context.** The client's current system is fully offline (desktop). Internet at the
shop is [⏳ intermittent]. The original wishlist ("full offline operation with
bidirectional sync and conflict resolution") is a research-grade problem; six weeks is
not enough to do it safely, and unsafe sync in a pharmacy corrupts stock. What must
survive an outage is *selling* — catalogue edits, purchasing, and reporting can wait.

**Decision.** The server is the single source of truth. The PWA maintains: (a) a
read-only catalogue + open-batch snapshot in IndexedDB, refreshed on connect and every
15 min; (b) an append-only queue of completed sales, each with a client-generated UUIDv7
`client_sale_id`. `POST /sync/sales` is idempotent on `client_sale_id` (unique index):
replays are acknowledged, never duplicated. Stock is deducted server-side at sync time;
if a batch was oversold during the outage, the sale still records (money was taken) and
a negative-stock exception lands on the Manager's adjustment queue rather than blocking
sync. All non-POS features require connectivity in MVP. Offline logins use the last
successful credential verification cached for 12 h (hash comparison locally, no role
elevation offline).

**Consequences.** *Easier:* no distributed conflicts by construction (append-only, one
writer per record); sync is a single idempotent endpoint we can test; matches the Week 5
"works on mobile 3G" reality. *Harder:* two devices selling offline from the same batch
can oversell — surfaced as an explicit exception report (accepted: it mirrors physical
reality — the tablets left the shelf); catalogue changes don't reach an offline till
until reconnect (accepted; price changes are Manager actions done online).

---

## ADR-007: Deployment — Vercel (web) + Railway (API + PostgreSQL)

**Status:** Superseded by ADR-009

**Context.** Course Week 5 requires a public URL for frontend and backend on free-ish
tiers, and Week 8 adds CI/CD. Options per brief: Vercel, Railway, Render. Render free
tier sleeps (cold starts kill the POS feel in demos); Railway's trial/hobby tier keeps
the API warm and bundles managed Postgres in the same project.

**Decision.** Frontend: Vercel (Vite static build + PWA assets, preview deploys per PR).
Backend + DB: Railway (NestJS container + managed Postgres, nightly `pg_dump` to
Supabase Storage or a private repo artifact for NFR-07). GitHub Actions from Week 4:
lint + test on every PR; deploy `main` → Railway/Vercel (formalized as the Week 8 CI/CD
deliverable). Secrets only in platform env vars; `.env.example` committed.

**Consequences.** *Easier:* zero-ops deploys the whole team can trigger; preview URLs
for the UX Lead's usability checks; HTTPS everywhere by default. *Harder:* two
platforms to configure CORS/env across; Railway hobby limits (~USD 5 credit) — we
monitor usage and the client is told the ~USD 5–10/month post-project cost before
handover (Assumption 5).

---

## ADR-008: Barcode input and receipt printing via browser-native paths

**Status:** Accepted

**Context.** The pharmacy already owns a USB barcode scanner and an 80 mm receipt
printer used by QB POS. Custom printer drivers (ESC/POS over USB/network) are
per-device rabbit holes we can't afford in six weeks.

**Decision.** Barcode in: treat the USB scanner as a keyboard wedge — a global listener
detects scan-speed keystroke bursts terminating in Enter and routes them to the POS
search box regardless of focus. Mobile fallback: `@zxing/browser` camera scanning.
Barcode out: labels rendered as Code 128 SVGs (`JsBarcode`) printed from the browser.
Receipts: a print-dedicated route styled with `@media print` CSS at 80 mm width, printed
via the browser dialog (silent printing configured on the till with a kiosk-mode flag if
the client wants it). ESC/POS direct printing is a Phase 2 spike, not MVP.

**Consequences.** *Easier:* zero drivers, works on any machine including the demo laptop;
printing testable by "print to PDF". *Harder:* browser print dialog adds one keypress
unless kiosk-mode silent printing is configured on the till (we will configure it at
handover); exotic printers may need margins tuned — verify the printer model at Visit 2
(Open Question 5).

## ADR-009: Deployment revision — Render (API) + Neon (PostgreSQL) replace Railway

**Status:** Accepted (supersedes ADR-007's backend/database choice; the Vercel frontend
decision stands)

**Context.** ADR-007 chose Railway to avoid Render's free-tier cold sleeps. Re-examined
before the Week 5 deploy: Railway has no permanent free tier — its one-time ~USD 5 trial
credit exhausts mid-semester and the API then silently stops, a worse failure mode for a
course project than a planned-for cold start. Two facts have also changed the weight of
the original objection: (1) the offline-first POS (ADR-006) masks API cold starts at the
till — the catalogue is cached and sales queue locally, so the star feature doubles as
the mitigation; (2) the team has prior production experience running the
Render + Neon + Vercel stack.

**Decision.** API: Render free web service built from `apps/api/Dockerfile`
(`render.yaml` blueprint; `/health` checks; migrations still run on boot). Database:
Neon free-tier PostgreSQL (Render's own free Postgres expires after 30 days). A GitHub
Actions keep-warm ping (`keepwarm.yml`, every 10 min during waking hours) plus a
pre-demo warm-up minimizes cold starts; nightly `pg_dump` (`backup.yml`) is unchanged —
it only needs the `PROD_DATABASE_URL` secret pointed at Neon.

**Consequences.** *Easier:* GHS 0 hosting for the whole semester with no expiring
credit; a stack the team has operated before; Neon branching gives free point-in-time
restore on top of NFR-07 dumps. *Harder:* worst-case ~50 s cold start if the ping lapses
(demo script: open the app two minutes early); CSP `connect-src` and `CORS_ORIGIN` must
be re-pointed at the `onrender.com` URL, tracked in the OWASP checklist.

---

## ADR-010: Multi-branch — one database, branch as a stock-location dimension

**Status:** Accepted

**Context.** After the MVP was built, the client disclosed that the pharmacy operates
from multiple shops rather than the single site assumed throughout Weeks 1–3. The system
had not yet gone into live use, so no production data needed rescuing — but every table
that records stock or money assumed one location.

Three shapes were considered. *Database per branch* gives the strongest isolation but
makes the consolidated reporting the owner actually wants (group sales, group stock
value) a cross-database join, and triples the hosting footprint on a free tier.
*Schema per branch* has the same reporting problem with worse migration ergonomics.
*One database with a branch column* keeps reporting trivial and hosting flat, at the cost
of isolation becoming an application concern rather than a physical one.

The deciding factor is that this is one business with one product catalogue and one
owner, not several tenants. Branches share products, prices, suppliers and customers;
they differ only in what stock sits on their shelves and what was sold across their
counters. That is a dimension, not a tenancy boundary.

**Decision.** A single database. Tables split into two groups:

| Group | Tables | Rationale |
|---|---|---|
| Branch-scoped (`branch_id NOT NULL`) | batches, stock_movements, stock_adjustments, sales, purchase_orders, goods_receipts | physical stock and the money taken against it |
| Branch-tagged (`branch_id` nullable) | notifications, audit_logs | a null row is system-wide and visible everywhere |
| Shared (no `branch_id`) | products, product_units, product_barcodes, categories, suppliers, customers, users, settings | one catalogue, one price list, one customer book |

Supporting decisions:

1. **Selling prices are global; reorder levels are not.** The client confirmed a product
   costs the same at every shop, so no per-branch price table. Reorder levels genuinely
   differ by shop size, so `branch_product_settings` carries an optional override that
   falls back to `products.reorder_level`.
2. **`role` stays global on `users`; reach comes from `user_branches`.** The client's
   managers each run one shop, so a per-branch role matrix would be complexity bought for
   nobody. A Manager is a Manager, and `user_branches` decides where.
3. **Branch travels in the signed JWT, not a header.** A till is physically at one shop
   for a whole shift, and a client-supplied `X-Branch-Id` would be one missed validation
   away from a cross-branch write. Switching branch is therefore a round-trip
   (`POST /auth/switch-branch`) that re-issues the access token.
4. **Isolation is enforced centrally by a Prisma client extension**, driven by an
   `AsyncLocalStorage` request context, rather than by a `where` clause remembered at
   ~60 call sites. Reads are auto-scoped; writes stay explicit (the generated types make
   `branchId` mandatory) and the extension validates them.
5. **Document numbers are branch-prefixed off the existing global sequences** —
   `KUM-RCP-2026-000123`. Receipt numbers stay globally unique, which the offline sync
   dedupe depends on, while still reading as belonging to a shop.
6. **`batches` is unique on `(branch_id, product_id, batch_number, expiry_date)`.** The
   same supplier batch legitimately arrives at two shops; the old global constraint would
   have rejected the second delivery.
7. **Branches are created by an administrator, not shipped with the system.** We do not
   know where the client's shops are, and seeding invented locations would put fabricated
   client data into a live system (MoU §4). The seed therefore creates a single, anonymous
   placeholder branch (`MAIN`) to hold demo stock, and the admin creates the real branches
   once site visits confirm them. Two consequences follow: an admin must be able to sign
   in when **no** branch exists yet — otherwise nobody could ever create the first one, a
   deadlock — and a branch code must stay editable until that branch has issued its first
   document.

**Consequences.** *Easier:* consolidated reporting is one `GROUP BY`; hosting is
unchanged; the shared catalogue means a product added once appears everywhere;
branch-prefixed indexes make per-branch queries touch a smaller working set than the
single-branch design did.

*Harder:* isolation is now a property of application code rather than physics. Two
residual risks are accepted rather than solved:

- **Raw SQL is invisible to the extension.** Eighteen `$queryRaw` sites exist, the FEFO
  allocator among them; each carries its branch predicate by hand and
  `test/branch-isolation.e2e-spec.ts` covers the paths that matter. Postgres RLS would
  close the hole completely but requires wrapping every scoped read in an interactive
  transaction to hold `SET LOCAL` across a pooled Neon connection — rejected as
  disproportionate for a known, small raw-SQL surface. Revisit if the business ever
  splits into genuinely separate owners.
- **Offline queue vs. branch switch.** A sale queued at one branch whose operator then
  switches branch before the queue drains cannot simply be rejected — the money was taken
  at the till. Queued sales carry their originating `branchId` and mismatches are
  quarantined for a manager, the same shape as the existing `NEG_STOCK_EXCEPTION`
  handling (ADR-006).

Two further points are policy, not defects, and are recorded here so the reports are read
correctly.

**In-transit stock** on a branch transfer is split deliberately: on dispatch the goods
leave the sending branch's *sellable* shelf immediately, so they can never be sold twice,
but they remain the sending branch's *asset* until the far end confirms receipt. The gap
is exposed by `v_in_transit` rather than left implicit, so it is neither double-counted
nor invisible. A transfer is therefore two one-sided operations — dispatch touches only
the sender, receipt only the receiver — which is both what physically happens and the
reason no transfer ever needs to write across a branch boundary.

**Branch-accurate history begins at go-live**, since no pre-existing data was migrated.
