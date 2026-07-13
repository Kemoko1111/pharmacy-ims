# Problem Discovery Note

**COE 454 — Week 1 Deliverable 3 (max 1 page)**
**Team:** [TEAM NAME] · **Codename:** PharmaTrack · **Date of Visit 1:** [DATE]

| Field | Detail |
|---|---|
| Business name | [PHARMACY NAME — from Site Visit 1 log] |
| Location | [SUBURB, e.g. Ayigya / Bomso / Kotei], Kumasi — off-campus, KNUST environs |
| Sector | Retail pharmacy (clinics & pharmacies — eligible sector, brief §3.1) |
| Contact | [OWNER / SUPERINTENDENT PHARMACIST NAME, ROLE] |
| Registration | [Business Operating Permit / Pharmacy Council registration — sighted? Y/N] |

## Observed problem

The pharmacy runs its entire sales and stock operation on **QuickBooks Desktop Point of
Sale 19.0 (Multistore level)** on a single Windows 10 computer. During the visit we
observed staff making sales and maintaining the item list in this software. Three
compounding problems were identified:

1. **The software is discontinued.** Intuit ended QuickBooks Desktop POS on 3 October
   2023 — no security updates, no technical support, and no ability to obtain or
   re-activate licenses. If the till PC fails, the pharmacy cannot reinstall its own
   system; the business is one hardware failure away from reverting to paper.
2. **No batch or expiry-date tracking.** QB POS tracks only a quantity-on-hand per item.
   Medicines expire; staff manage expiry by physically inspecting shelves. Expired stock
   is a direct financial loss and a regulatory risk (Pharmacy Council of Ghana
   inspections). *(Severity and frequency to be quantified in the Visit 2 interview.)*
3. **Data is trapped on one machine.** No off-site backup, no remote access for the
   owner, one till only. Reordering relies on a static "reorder point" field per item and
   manual review; low-stock and expiry situations are discovered, not signalled.

## Why it matters to the business

- **Continuity risk:** a dead PC or corrupted database ends digital operations permanently.
- **Money:** expired stock is written off; stock-outs of fast movers lose sales; both are
  currently managed by memory and shelf checks.
- **Compliance:** expiry control and sales records are inspection items for a licensed
  pharmacy.
- **Owner visibility:** no way to see sales or stock without standing at the till.

## Proposed direction (subject to Visit 2 requirements interview)

A web-based inventory + POS system the pharmacy owns: medicine catalogue with
batch/expiry tracking, barcode-driven sales with printed receipts, purchase orders and
stock receiving, automatic low-stock and expiry alerts, role-based accounts (owner,
pharmacist, cashier), and an offline-tolerant till for internet outages — with the
existing QB item list migrated in via CSV export so the pharmacy does not start from zero.
