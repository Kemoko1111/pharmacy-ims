# Class Pitch — 5 minutes (Week 2 Deliverable 5)

**Format per brief:** Problem → User → Proposed Solution. Presenter: PM (BA supports on
requirements questions). Max ~6 slides. Rehearse to 4:30 to leave buffer.

## 0:00–0:45 — Hook & problem
> "This pharmacy in [SUBURB] runs entirely on software that no longer exists."

- QuickBooks Desktop POS 19 — discontinued by Intuit, Oct 2023. No support, no patches,
  **no reinstall if the one PC that runs it dies.**
- Show the site-visit photo (with consent): the till, the software.
- And even while it works: **no batch or expiry tracking** — in a business legally
  required to manage medicine expiry.

## 0:45–1:45 — The users (personas)
- **Akosua, cashier:** thousands of SKUs, strip-vs-tablet confusion, lookup is slow.
- **Mr. Boateng, owner/pharmacist:** finds expired stock during shelf checks — after the
  money is lost; can't see the business unless he's standing at the till.
- One real observation from Visit 1 (quote the site visit log, not invented).

## 1:45–3:30 — Proposed solution (wireframes, not tech)
- **PharmaTrack:** web-based POS + inventory the pharmacy owns.
- Walk the two starred wireframes:
  1. POS screen — scan, sell by carton/pack/strip/tablet, print receipt, **keeps working
     offline** (amber badge, auto-sync).
  2. Owner dashboard on a phone — today's takings, low-stock list, batches expiring in
     90 days.
- Batch + expiry engine (FEFO) is the differentiator over what they had.
- Their existing QB item list migrates in via CSV — no retyping thousands of products.

## 3:30–4:15 — Scope honesty & delivery plan
- MVP in 6 weeks = the 13 Must-Have stories: auth/roles, catalogue, batches/expiry, POS
  + receipts + offline queue, purchasing/receiving, adjustments, alerts, core reports.
- Explicitly **not** building: multi-branch, insurance claims, accounting integration,
  forecasting.
- Stack in one line: React PWA + NestJS modular monolith + PostgreSQL, deployed to a live
  URL by Week 5; SMS alerts (Africa's Talking) as the third-party integration.

## 4:15–4:45 — Close
- "One hardware failure from paper" → after Week 6: cloud-backed, expiry-safe,
  owner-visible from anywhere.
- Ask for critique on: offline scope (is a sales-only queue enough for MVP?) and the
  report list.

## Anticipated questions
| Question | Answer |
|---|---|
| Why not just buy pharmacy software? | Commercial options are subscription-priced in USD and none migrate their QB data; also, the course requires we build it — and they get ownership (MoU §5). |
| How do you handle offline conflicts? | Sales are append-only events with client-generated IDs — no two devices edit the same record, so sync is idempotent, not conflicting. Catalogue edits are online-only in MVP. |
| Is patient data involved? | Only optional customer name/phone; handled under Act 843; no medical records in scope. |
| What if the internet is down for days? | POS keeps selling from the cached catalogue; queue persists in the browser's IndexedDB and syncs when back. |
