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

## ADR-004: Database — PostgreSQL with Prisma ORM

**Status:** Accepted (amended 2026-08-06 — the major version is now 17, see the addendum)

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

**Addendum, 2026-08-06 — the major version is 17.** Neon upgraded the managed production
instance to PostgreSQL 17 without us choosing to, while `docker-compose.yml`, the CI
service container and the no-Docker `db:local` script all still ran 16. Nobody noticed
until the nightly `pg_dump` began failing, because a dump client refuses a server newer
than itself — which meant that for several days the backup we believed we had did not
exist. A silent major-version drift between development and production is exactly the
class of defect this ADR exists to prevent, so all three are now pinned to 17 (the
embedded fallback to 17.10, matching the Neon server exactly). The full e2e suite passes
unchanged on 17.

The decision itself does not change — Postgres accessed through Prisma; only the number
moved. Two deliberate omissions: the applied migration SQL keeps its original
`PostgreSQL 16` header comment, because editing a migration that has already run changes
its checksum and would crash-loop `prisma migrate deploy` on the next boot; and anyone
holding an old local volume must drop it (`docker compose down -v`, or
`rm -rf apps/api/.pgdata`), since a 16 data directory will not start under 17 — `db:local`
now detects that and says so instead of failing opaquely.

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

**Status:** Accepted (supporting decision 1 superseded by ADR-011)

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
   *(⚠️ Superseded by ADR-011 — the client withdrew this answer on 2026-08-02 and asked
   for branch-level prices. The rest of this ADR stands.)*
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

---

## ADR-011: Branch-level selling prices

**Status:** Proposed (supersedes ADR-010 supporting decision 1)

**Context.** ADR-010 recorded that "a product costs the same at every shop" — the
client's own answer to a direct question — and built on it. Selling price therefore
lives on `products.selling_price_base`, `branch_product_settings` carries only a reorder
level, and the offline catalogue caches one price per product.

On 2026-08-02 the client withdrew that answer, asking in CR-2026-08-02 §8 for "different
pricing configurations at the branch level". No reason was given, and the reason matters:
a standing difference between two shops is a different feature from occasional local
promotions, and only the second needs effective dates. §10 q14 of the SRS asks.

This is the first recorded reversal of a premise an accepted ADR was built on, so it is
documented as a superseding decision rather than absorbed silently.

**Decision (proposed).** Add an optional per-branch override, resolved with fallback,
rather than moving price onto the branch wholesale:

1. `branch_product_settings` gains a nullable `selling_price_base`. A null means "no
   local opinion" and the branch sells at `products.selling_price_base`. This keeps the
   common case — one price everywhere — as one row in one table, and makes a divergent
   price a visible exception rather than 26 duplicated rows per branch.
2. Price resolution happens in one place, server-side, alongside the existing branch
   scoping, so no call site can accidentally read the base price at a branch that has an
   override. The POS, receipts, returns and stock valuation all consume the resolved
   price.
3. `price_history` gains a nullable `branch_id`. A null row is a change to the base
   price; a non-null row is a change to one branch's override. BR-03's requirement that
   every change be versioned and attributable holds either way.
4. The offline catalogue snapshot already ships per branch (ADR-010), so it carries that
   branch's *resolved* prices. An offline sale is then priced identically to an online
   one without the till needing the override rules.
5. Returns and reprints price from the sale record, not from today's resolution — a
   refund must match what the customer actually paid.

**Alternatives considered.** *Price rows per branch for every product* — uniform, but
turns "change this product's price" into a fan-out across branches and makes the common
case the expensive one. *Percentage modifier per branch* — compact, but the client asked
for prices, not margins, and rounding a modifier produces prices no one chose, which is
unacceptable on a shelf label. *Price lists as a first-class entity, branches subscribing
to one* — the general answer, and the right one for a chain with tiers; disproportionate
for a client with a handful of shops who has not yet said the difference is systematic.

**Consequences.** *Easier:* a branch can be repriced without touching any other; the
group price list stays a single number to maintain.

*Harder:* "the price" stops being a column read and becomes a resolution, so anything
that quotes a price must go through it — a bug class that did not exist before. Existing
reports that value stock at `products.selling_price_base` become wrong at any branch with
an override and must be updated together with the schema. Until §10 q14 is answered the
override is a single current price with no effective dating; if the client turns out to
want scheduled local promotions, that is a further change on top of this one.

---

## ADR-012: Offline reliability — reachability-based sync, and cached sign-in

**Status:** Accepted (refines ADR-006)

**Context.** ADR-006 designed the offline POS and got the hard part right: an
append-only queue drained through an idempotent endpoint. Three things around it were
wrong in practice, all found in use rather than in test.

*The queue drained from one trigger.* `drainQueue()` was called only from the browser's
`online` event, which fires on a *transition*. A till that is closed with sales queued
and reopened the next morning already on WiFi never sees a transition, so the sales sat
there indefinitely. The unsynced badge was correct and nothing was ever lost — but the
only reliable way to make it move was to unplug the network and plug it back in.

*"Online" meant `navigator.onLine`.* That reports a route, not a reachable server. Shop
WiFi with a dead uplink, a hotspot out of credit, or the free-tier API asleep all read as
ONLINE. The till then made live requests that hung — `fetch` has no default timeout —
so the payment dialog could sit on "Completing…" for minutes with a customer waiting,
while the queue that exists for exactly this case was never engaged.

*Offline sign-in was specified but not built.* ADR-006 says "offline logins use the last
successful credential verification cached for 12 h". Only the *session* half shipped: a
reload during an outage survives, but a cold sign-in posts to `/auth/login` and fails.
The shop that opens during an outage cannot get into the till at all. The client raised
this as CR-2026-08-02 §7.

**Decision.**

1. **Reachability replaces link state.** `isOnline()` means "the API answered recently",
   established by a heartbeat against the unprefixed `GET /health` plus the outcome of
   every real request the app already makes. `navigator.onLine === false` is still
   trusted as an immediate offline signal — it is never wrong in that direction.
2. **Every request is time-boxed** (15 s default, 7 s for the sale POST). A timeout is
   raised as `NetworkError`, distinct from `ApiError`, so the queue path handles a hung
   link exactly as it handles a dead one. A sale at the till never waits on the network
   longer than it takes to print.
3. **The queue drains from every occasion that could change the outcome**: app start,
   reachability recovery, a sale being queued, the tab regaining focus, and a backoff
   timer (5 s doubling to 5 min) while anything is still waiting. Concurrent triggers
   collapse into one request.
4. **Failures become visible.** A sale the server refuses stays queued — the money was
   taken — but records the reason and an attempt count, and after three attempts is
   counted separately as *rejected* rather than hiding inside "unsynced". Sales queued at
   another branch are counted separately again, as *other branch*: no amount of retrying
   moves those until the till switches back (ADR-010).
5. **Cached sign-in.** A successful *online* sign-in leaves a password verifier on the
   device — PBKDF2-HMAC-SHA256, 600 000 iterations, per-record random salt, in IndexedDB.
   When the server cannot be reached, `login()` verifies against it locally. It is
   consulted only on network failure: an `ApiError` means the server answered and said
   no, and no local cache may override that.

**Revision to ADR-006's 12 hours.** ADR-006 gave one TTL for what are two different
things. The cached *session* stays at 12 h — it covers a reload inside one shift. The
*verifier* is kept for 7 days, because the case that motivated the CR is "the shop opens
on Monday and the line is down", which a 12-hour window does not reach. It is refreshed
on every online sign-in and, deliberately, is **not** cleared by signing out: a cashier
who signs out at close of business must still be able to open the till during tomorrow's
outage. Revoking a device is a separate explicit act, in Settings.

**Security position, stated plainly.** The verifier is a one-way hash of the same shape
the server stores; the password is never persisted. A stolen till yields an offline-
crackable hash, so: high iteration count, per-record salt, lockout for 15 min after 5
failed attempts, one cached user per device (the current signer-in replaces the last),
and the 7-day expiry. A password changed or an account disabled on the server is not
known to a till that cannot reach the server — this is inherent to offline auth, and is
bounded by the TTL. An offline session grants **local till operation only**: it holds no
token, so it makes no authenticated requests at all, and nothing it produces reaches the
database until a genuine online session posts the queue, where the server re-checks the
user, the role and the branch. `crypto.subtle` requires a secure context, so offline
sign-in is unavailable over plain HTTP rather than silently downgraded to a weak hash.

**Consequences.** *Easier:* the queue drains on its own from any starting state; a weak
link degrades to the offline path in seconds instead of minutes; a shop can open during
an outage; a rejected sale is a thing a manager can see rather than a number that never
goes down.

*Harder:* "online" is now a probe result, so it can lag reality by up to one heartbeat
(20 s while down, 60 s while up) — acceptable, since a wrong "online" costs one timed-out
request. A session opened offline is bounced to the sign-in screen once someone chooses
to sync, because it has no token to post with; the queue survives that and the sign-in
screen says how many sales are waiting. The 7-day verifier is a real widening of the
window in which a stolen till is useful to an attacker, accepted against the cost of a
pharmacy that cannot sell.

---

## ADR-013: Offline beyond the POS — a cached read layer for every screen

**Status:** Accepted for reads (2026-08-07). Writes are phase 2 and are **not** built yet;
their design and risks are recorded here because the client has asked for them.

**Context.** ADR-006 made the POS work without a network and deliberately stopped there:
selling is the thing a pharmacy cannot pause, and a purpose-built catalogue snapshot was
the cheapest way to guarantee it. Every other screen calls `api()` directly.

The client tested during an outage and reported that "even the products don't work". He
was right, and the diagnosis was worse than the symptom: only 5 of 16 screens had any
offline path, so the other eleven rendered an **empty table with no explanation** —
indistinguishable from "this pharmacy has no products". Two faults sat underneath:

1. No offline data for anything but the POS catalogue.
2. A till that *reloaded* during an outage lost its session entirely. The cached shift
   session was adopted only by a 2.5 s "slow server" grace timer, but a refused
   connection fails in milliseconds and the `finally` block then cancelled that timer.
   The cashier was returned to a login screen that could not be reached, holding a
   perfectly valid session. Fixed with this ADR.

He has asked for the whole system to work offline, including administration.

**Decision.** Cache at the one seam every screen already shares — `api()` — rather than
building fifteen more bespoke snapshots that would each have to be kept in step with the
server.

1. **Successful GETs are recorded; failed GETs are served from that record.** The key is
   the request path, scoped by branch, so a screen shows what it last showed. No screen
   code changes: sixteen screens gained offline reads without sixteen edits, and screens
   added later inherit it.
2. **A separate, disposable IndexedDB database.** `offline.ts` holds work the shop cannot
   afford to lose — queued sales, held carts, sign-in verifiers. This cache can be
   rebuilt by going online, so it is capped (300 entries, 512 KB each, oldest evicted)
   and cleared without ceremony. Mixing the two would put an eviction policy next to
   unsynced money.
3. **Never cached:** `/auth/*` (a replayed credential answer is a security question, not
   a convenience), `/health` (a cached "ok" would tell the connectivity layer the server
   is up while it is down), `/sync/*`, and `/catalog/snapshot`, which has its own store.
4. **The POS opts out.** Its offline answers come from the branch snapshot, which knows
   this shop's stock, not from whatever a previous search happened to return.
5. **The UI never pretends.** A banner states the data is saved and from when; a screen
   with no saved copy says so instead of rendering an empty table. Staleness reports the
   *oldest* read on the page, because a page is as stale as its worst part.
6. **Sign-out clears it.** Cached screens can hold the user list, the day's takings and
   the audit log; on a shared till, signing out has to take them with it. The durable
   queues stay — an unsynced sale belongs to the shop, not the departing cashier.

**Alternatives considered.** *A snapshot endpoint per screen* — accurate and
branch-aware, but fifteen more contracts to version and keep honest, for screens that are
read far less often than the POS. *Service-worker HTTP caching* — free and automatic, but
it caches at the wrong layer: no branch scoping, no staleness surfaced in the UI, and no
way to clear it on sign-out. *React Query persistence* — close, but it restores query
state including errors, and would have re-served the empty-table failure faithfully.

**Consequences.** *Easier:* every screen is readable during an outage, including ones
written later; the till survives a restart mid-outage; the failure mode changed from a
silent lie to a dated statement.

*Harder:* a manager can now read yesterday's stock while believing it is today's — the
banner is the only thing standing between him and a bad reorder, so it must never be
suppressed for tidiness. Cached data now sits on the device, which is why sign-out clears
it and why nothing under `/auth` is ever stored. And a screen must be opened online once
before it works offline, which is a real limitation: the first outage after a new screen
ships still shows nothing.

**Phase 2 — offline writes (built 2026-08-07).** Every screen's writes are now
queued when the server cannot be reached, administration included, as the client asked.

*Replay protection came first.* A till that posts a queued write and loses the answer
cannot tell "never arrived" from "arrived, reply lost"; retrying is all it can do, and a
phantom delivery is a stock figure nobody can reconcile. Sales were already safe through
`sales.client_sale_id`; everything else now goes through a generic `Idempotency-Key`
mechanism (`idempotency_keys` + a global interceptor). The queue row's own id *is* the
key, so a write and its retry are the same operation by construction.

*Queued, not applied locally.* The screens keep showing the last synced state, and a
badge shows what this till has done that the server has not seen. Applying edits locally
and displaying them as fact would be a claim we cannot back — the server may refuse the
write, and a manager who has seen a price "change" on screen will not go back to check.
The cost is that the cashier's own edit is not visible in the list until it syncs, which
is why the pending-changes panel exists: what was done, when, and what the server said.

*Order is preserved and failures are separated.* The drain is strictly sequential, oldest
first, because a create and the edit that follows it must arrive that way round. A
transport failure stops the drain rather than skipping ahead. A **refusal** — the server
answered and said no — is recorded against that write and the drain continues, so one bad
row cannot strand a shift's work. Refusals never retry: they need a person, and they say
which write and what the server's reason was.

*The admin risks the client accepted, unchanged.* Queueing a role change does not make it
safe: an access change made on a disconnected till only takes effect when it syncs, and
two managers editing the same user offline will have the later drain win with no warning.
The audit row records the sync time, not the decision time. Settings edits are applied by
the server against its current state rather than by the till against its stale copy,
which limits — but does not remove — the "repriced sales already taken" problem. These
were raised before building and the client chose to proceed; they are recorded here so
the choice is visible rather than implied.

*Deliberately not queued:* authentication (a replayed credential answer is a security
question), the POS sale path (it has its own queue with its own natural key), and
notification "seen" flags (UI state, not work).
