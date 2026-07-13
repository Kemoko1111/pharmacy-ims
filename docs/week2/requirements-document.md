# Requirements Document / Software Requirements Specification

**Project:** PharmaTrack — Pharmacy Inventory & POS System
**Course:** COE 454 — Week 2 Deliverable 1 (structure per brief §4.2.2)
**Version:** 0.9 (draft — items marked ⏳ must be confirmed in the Site Visit 2 interview)
**Owner:** Business Analyst · **Reviewed by:** full team

This document serves as both the course Requirements Document and the project's Software
Requirements Specification (SRS). Sections follow the brief's required structure, extended
with business rules, assumptions, and constraints per IEEE 29148 practice.

---

## 1. Business context

[PHARMACY NAME] is a licensed retail pharmacy in [SUBURB], Kumasi, within the KNUST
environs. It serves walk-in retail customers — students, residents, and nearby workers —
selling prescription and over-the-counter medicines alongside cosmetics, food & drinks,
and diagnostic consumables (as reflected in the department structure of its current
system). The pharmacy operates [⏳ N] tills with [⏳ N] staff: [⏳ owner/superintendent
pharmacist, pharmacist(s), counter assistants/cashiers]. Daily transaction volume is
[⏳ N] sales/day across a catalogue of [⏳ ~N thousand] stock items.

## 2. Problem statement

The pharmacy's sales and inventory run on QuickBooks Desktop Point of Sale 19.0
(Multistore), installed on a single Windows 10 computer. This creates four problems:

1. **Unsupported platform.** Intuit discontinued QuickBooks Desktop POS on 3 Oct 2023.
   There are no security updates, no support, and no way to obtain new licenses. A
   hardware failure of the till PC would permanently end the pharmacy's digital
   operations, because the software cannot be reinstalled or re-activated.
2. **No batch/expiry management.** The system tracks a single quantity-on-hand per item
   with no batch numbers or expiry dates. Expiry control — a regulatory obligation for a
   licensed pharmacy — is done by physically inspecting shelves, and expired stock is
   discovered late, after the money is already lost.
3. **Reactive stock control.** Reordering depends on a static per-item reorder-point
   field and manual review. Stock-outs of fast-moving items and over-stocking of slow
   movers are discovered at the shelf, not signalled by the system.
4. **Data confinement.** All records live on one machine with no off-site backup and no
   remote visibility. The owner cannot see sales, stock, or cash position without being
   physically at the till.

The problem is the pharmacy's *operational dependence on an unsupported, single-machine
system that cannot manage medicine expiry* — not the absence of any particular product.

## 3. User personas

*(Draft personas built from Visit 1 observation; validate names, ages, and details in
Visit 2. Replace with real role-holders' characteristics — do not invent quotes.)*

### Persona 1 — "Akosua", Counter Assistant / Cashier
| Attribute | Detail |
|---|---|
| Role | Serves customers at the till; makes ~[⏳ N] sales/day |
| Age / tech comfort | ⏳ [e.g., 20s, comfortable with Android smartphone, types slowly on PC] |
| Goals | Serve each customer fast; never sell the wrong strength/brand; balance the till at day end |
| Frustrations | Slow item lookup among thousands of SKUs; strip-vs-tablet quantity confusion; system freezes with no one to call |
| Device / connectivity | Shared Windows till PC; personal Android phone on mobile data |

### Persona 2 — "Mr. Boateng", Owner / Superintendent Pharmacist
| Attribute | Detail |
|---|---|
| Role | Owns the pharmacy; responsible to the Pharmacy Council for professional standards |
| Age / tech comfort | ⏳ [e.g., 40s–50s, uses WhatsApp and email daily, delegates PC work] |
| Goals | Know daily takings and what to reorder without standing at the till; never fail an inspection over expired stock; protect 20+ years of business records |
| Frustrations | Discovers expired stock during shelf checks; can't check the business from home; knows the POS software is dead-ended but migration feels risky |
| Device / connectivity | Personal laptop + smartphone; pharmacy has [⏳ Wi-Fi? mobile-data hotspot?] |

### Persona 3 — "Adjoa", Duty Pharmacist *(supporting persona)*
Dispenses prescription medicines, advises customers, supervises cashiers on shift, and
performs stock receiving when deliveries arrive. Needs fast product/stock lookup by
generic name and the authority to approve returns and stock adjustments that cashiers
cannot.

## 4. Functional requirements (user stories)

Priorities use MoSCoW: **M**ust / **S**hould / **C**ould / **W**on't (this phase).
MVP = all M stories. Each story becomes a GitHub issue (Week 3).

---

**US-01 · Secure login — M**
As a staff member, I want to log in with a username and password so that only authorized
people can use the system.
- AC1: Valid credentials open a session appropriate to the user's role; invalid ones show a generic error (no username/password hinting).
- AC2: Five consecutive failures for one account trigger a 15-minute lockout, and the event is recorded in the audit log.
- AC3: Sessions expire after being idle for a configurable period (default 12 h); expired sessions redirect to the login screen without losing an in-progress cart.

**US-02 · Role-based access — M**
As the owner, I want each account to have a role (Admin, Pharmacist, Cashier, Inventory
Officer, Manager) so that staff can only perform actions appropriate to their job.
- AC1: A Cashier can sell and view products but cannot edit prices, delete products, or see profit reports.
- AC2: Only Admin can create/deactivate users and change system settings.
- AC3: Every privileged action (price change, adjustment approval, refund) records who did it.

**US-03 · Medicine catalogue — M**
As an inventory officer, I want to create and edit products with generic name, brand
name, strength, form, category, barcode, and prices so that the catalogue reflects what
we actually sell.
- AC1: A product records at minimum: name, generic name, strength, dosage form, category, unit cost, selling price, VAT flag, reorder level, and zero or more barcodes.
- AC2: Duplicate barcode entry is rejected with a message naming the conflicting product.
- AC3: Products are deactivated (soft delete), never destroyed — historical sales still reference them.

**US-04 · Multi-unit packaging — M**
As a cashier, I want to sell in cartons, packs, strips, or single tablets with automatic
conversion so that quantities and prices are always right.
- AC1: A product defines a base unit (e.g., tablet) and optional larger units with conversion factors (strip = 10 tablets; pack = 10 strips) and per-unit prices.
- AC2: Selling 2 strips reduces stock by 20 tablets; stock displays as "4 packs, 3 strips, 6 tablets" style breakdown.
- AC3: A unit's conversion factor cannot be edited once movements exist against it (new unit versions instead).

**US-05 · Batch & expiry tracking — M**
As a pharmacist, I want every stock receipt recorded against a batch with an expiry date
so that we always know which stock expires when.
- AC1: Receiving stock requires batch number and expiry date; quantity-on-hand is the sum of non-expired batch quantities.
- AC2: Sales deduct from the earliest-expiring batch first (FEFO), with manual override recorded.
- AC3: A batch that reaches its expiry date is automatically excluded from sellable stock and appears on the expired-stock report.

**US-06 · Barcode-driven POS sale — M**
As a cashier, I want to scan or search items into a cart and take payment so that a
routine sale takes seconds.
- AC1: A USB barcode scan adds the item to the cart instantly; unknown barcodes prompt a product search.
- AC2: Search by brand name, generic name, or barcode returns results in <300 ms over a 10,000-product catalogue.
- AC3: Completing a sale records line items, quantities, unit prices, discounts, payment method (cash / MoMo), amount tendered, and change; stock is deducted atomically.

**US-07 · Receipt printing — M**
As a cashier, I want a printed receipt for every sale so that customers have proof of
purchase and we have a paper trail.
- AC1: Receipt shows pharmacy name/address, receipt number, date/time, cashier, line items with quantities and prices, VAT breakdown, total, tendered, and change.
- AC2: Prints on 80 mm thermal paper via the browser print dialog in ≤3 s; reprint is possible from sale history (marked "REPRINT").

**US-08 · Offline-tolerant till — M**
As a cashier, I want to keep selling when the internet drops so that customers are never
turned away.
- AC1: With no connectivity, the POS continues from a locally cached catalogue; completed sales queue locally with a client-generated ID.
- AC2: When connectivity returns, queued sales sync automatically; each syncs exactly once (idempotent) even across retries.
- AC3: The screen shows a clear online/offline indicator and the count of unsynced sales; unsynced sales survive a browser restart.

**US-09 · Purchase orders & receiving — M**
As an inventory officer, I want to raise purchase orders to suppliers and receive
deliveries against them so that incoming stock is controlled and traceable.
- AC1: A PO records supplier, expected items/quantities/costs, and status (draft → sent → partially received → received → closed).
- AC2: Receiving records actual quantities, batch numbers, and expiry dates per line; over-receipt beyond PO quantity requires Manager approval.
- AC3: Receiving updates stock immediately and recalculates weighted-average cost.

**US-10 · Low-stock alerts — M**
As the owner, I want automatic low-stock alerts so that fast movers are reordered before
they run out.
- AC1: Each product has a reorder level; stock at or below it appears on the low-stock dashboard list.
- AC2: A reorder suggestion (product, current stock, suggested quantity, preferred supplier) can be exported/turned into a draft PO in one action.

**US-11 · Expiry alerts — M**
As a pharmacist, I want advance warning of expiring batches so that we can sell down,
return, or quarantine stock before it expires.
- AC1: Dashboard lists batches expiring within 30/60/90 days (configurable), with quantity and value at risk.
- AC2: Expired batches are flagged for quarantine and cannot be sold; disposal/return is recorded as a stock adjustment with reason.

**US-12 · Stock adjustments — M**
As a manager, I want damaged, lost, or miscounted stock corrected through a recorded
adjustment so that system stock matches the shelf without hiding shrinkage.
- AC1: An adjustment records product, batch, quantity delta, reason (damage / theft / count correction / expiry disposal), and free-text note.
- AC2: Adjustments above a configurable threshold require Manager/Admin approval before applying.
- AC3: All adjustments appear in the audit log and the shrinkage report.

**US-13 · Daily sales & stock reports — M**
As the owner, I want end-of-day and periodic reports so that I know takings, what sold,
and what it cost.
- AC1: End-of-day (Z) report: total sales, sales by payment method, by cashier, VAT collected, and refunds for a chosen date.
- AC2: Reports for any date range: sales by product/category, current stock valuation (at cost), low stock, expiring stock, adjustment/shrinkage log.
- AC3: Any report exports to PDF and CSV.

**US-14 · Returns & refunds — S**
As a cashier, I want to process a return against an original receipt so that refunds are
controlled and stock is corrected.
- AC1: A return references the original sale; quantity returned cannot exceed quantity sold.
- AC2: Refunds require Pharmacist/Manager approval; returned sellable stock re-enters inventory against its original batch, non-sellable stock becomes a disposal adjustment.

**US-15 · Customer records — S**
As the owner, I want optional customer profiles on sales so that regulars and
credit/insurance sales can be tracked.
- AC1: A sale can optionally attach a customer (name, phone); customer history lists their purchases.
- AC2: Customer personal data is visible only to Pharmacist role and above.

**US-16 · QuickBooks data migration — S**
As the owner, I want our existing item list imported so that we do not retype thousands
of products.
- AC1: A CSV exported from QB POS (item name, department, price, cost, on-hand qty, item no.) imports with a preview and per-row error reporting.
- AC2: Imported on-hand quantities are created as an "opening balance" batch with owner-confirmed default expiry review flags.

**Won't have (this phase):** multi-branch/stock transfer, e-prescriptions, insurance
claim submission, supplier portal, accounting integration, demand forecasting. See §7.

## 5. Non-functional requirements

| ID | Category | Requirement |
|---|---|---|
| NFR-01 | Performance | Product search returns in <300 ms and a full sale completes (scan → receipt) in <90 s at the 95th percentile, with a 10,000-product catalogue on the pharmacy's existing hardware. |
| NFR-02 | Availability / offline | The POS remains usable for sales during internet outages of at least 8 hours (one full trading day); no completed sale is ever lost. Target service availability 99.5% monthly for the hosted API. |
| NFR-03 | Security | Passwords hashed with argon2id; all traffic over HTTPS; RBAC enforced server-side on every endpoint; OWASP Top 10 checklist passed (Week 7); privileged actions audit-logged with user, timestamp, and before/after values. |
| NFR-04 | Usability | A new cashier completes a supervised sale within 2 hours of first use; POS fully operable by keyboard + scanner alone; UI legible on a 1366×768 till screen and a 5" phone over 3G. |
| NFR-05 | Reliability / integrity | Stock quantity is never updated except through a recorded movement (sale, receipt, adjustment, return); concurrent sales of the same batch cannot oversell it (atomic, transactional deduction). |
| NFR-06 | Compliance | Customer personal data handled per Ghana Data Protection Act, 2012 (Act 843): minimal collection, role-restricted access, no third-party sharing. Client operational data is never pasted into external AI tools without written consent (MoU §4). |
| NFR-07 | Backup / recovery | Automated daily database backups with 30-day retention; documented restore procedure tested before handover; recovery point objective ≤24 h, recovery time objective ≤4 h. |
| NFR-08 | Maintainability | Modular monolith with module boundaries enforced by folder structure and lint rules; ≥5 automated API tests by Week 4 growing with each sprint; any team member can run the system locally from the README in <15 minutes. |

## 6. Business rules

| ID | Rule |
|---|---|
| BR-01 | Stock is deducted first-expiry-first-out (FEFO) by default; overrides are logged. |
| BR-02 | Expired batches are unsellable from 00:00 on the day after expiry. |
| BR-03 | Selling prices can only be changed by Manager/Admin; every change is versioned with effective date. |
| BR-04 | A sale is immutable once completed; corrections happen only via the returns process. |
| BR-05 | Refunds and stock adjustments above [⏳ GHS X] require Manager approval. |
| BR-06 | Every user has an individual account; shared logins are prohibited (audit integrity). |
| BR-07 | VAT/levies are applied per product flag at rates configured in Settings (Ghana VAT + NHIL/GETFund as applicable ⏳ confirm the pharmacy's tax treatment). |
| BR-08 | Controlled/prescription-only medicines are flagged; the sale screen displays the flag (recording prescriber details is Phase 2 ⏳). |

## 7. Out of scope (this phase — explicit, per brief §4.2.2)

Multi-branch operation and inter-branch stock transfer · e-prescription capture ·
health-insurance (NHIS/private) claims · accounting/GL integration · supplier ordering
portal · payroll/HR · demand forecasting or any ML features · hardware procurement
(scanner/printer are the pharmacy's existing devices) · native mobile apps (the PWA
covers mobile).

## 8. Assumptions

1. The pharmacy's existing hardware (Windows PC, USB barcode scanner, receipt printer) keeps working and is available to the new system. ⏳ Confirm printer model.
2. The pharmacy has, or will provision, an internet connection at the till (Wi-Fi or phone hotspot); connectivity may be intermittent — hence NFR-02.
3. QuickBooks POS can still export its item list to CSV/Excel. ⏳ Verify on-site during Visit 2 before committing to US-16.
4. The owner will designate staff time for a 2-hour training session before handover.
5. Hosting stays within free/hobby tiers during the academic phase (≈ GHS 0/month); the client is informed of post-project hosting costs (~USD 5–10/month) before handover.

## 9. Constraints

1. **Time:** MVP live by end of Week 5; refined and accepted by end of Week 6.
2. **Team:** 7 students, 3 of whom are in non-coding roles; realistically 3–4 implementers part-time.
3. **Course:** must be deployed to a public URL, usable on a mobile browser over 3G, include ≥1 third-party integration (SMS/payments/storage), JWT auth, and PR-based workflow.
4. **Budget:** no software budget; only free tiers and open-source components.
5. **Legal:** MoU confidentiality clause — client data stays off third-party AI tools and is deleted from team devices at semester end.

## 10. Open questions (for Site Visit 2)

| # | Question | Why it matters |
|---|---|---|
| 1 | How many sales/day and how many products are in the QB item list? | Sizing, performance targets, migration effort |
| 2 | Has the pharmacy lost money to expired stock? Roughly how much per quarter? | Quantifies the core value proposition for the pitch |
| 3 | Who currently does reordering, and how do they decide? | Shapes US-10 reorder suggestions |
| 4 | Cash only, or MoMo too? Split payments needed at the till? | Payment model on US-06 |
| 5 | What receipt printer model is installed? | Print integration approach (browser vs ESC/POS) |
| 6 | Internet at the shop: Wi-Fi, router, or phone hotspot? How reliable? | Calibrates the offline requirement |
| 7 | Do they extend credit to customers, or bill any institutions? | Whether US-15 needs credit balances |
| 8 | Which reports does the owner actually look at today (if any)? | Prioritize US-13 report list |
| 9 | Can QB POS export the item list on their machine? | Feasibility of US-16 migration |
| 10 | Are there multiple staff accounts in QB today, or one shared login? | Change management for BR-06 |
| 11 | Any second location or plans for one? | Validates excluding multi-branch |
| 12 | Cloud storage of business data — comfortable? Any data they consider sensitive? | Consent + Act 843 posture; MoU §4 |
