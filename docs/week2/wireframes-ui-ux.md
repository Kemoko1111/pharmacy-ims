# UI/UX Specification & Wireframes

**COE 454 — Week 2 Deliverable 4 (accompanies the User Personas)**
**Owner:** UX / Design Lead

Low-fidelity wireframes for the primary user flows. The UX Lead should redraw the two
starred (★) screens in Figma/Excalidraw for the class pitch; these ASCII frames are the
agreed source of layout truth.

## Design principles

1. **Keyboard + scanner first.** Akosua's hands stay on the scanner and keypad; the mouse
   is optional on every POS action.
2. **Big targets, high contrast.** Till screens are old and viewed at arm's length;
   minimum 16 px body text, 44 px touch targets (owner will use a phone).
3. **Status always visible.** Online/offline state, unsynced sale count, and logged-in
   user are permanently in the top bar — trust in the offline mode depends on it.
4. **Nothing destructive is one click.** Voids, refunds, adjustments always confirm and
   always name the approver.
5. **3G-friendly.** Route-level code splitting; catalogue cached locally; no images on
   hot paths; every list paginated/virtualised.

## Color & theme

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | #F8FAFC | #0F172A | App background |
| `--surface` | #FFFFFF | #1E293B | Cards, tables |
| `--primary` | #0D9488 (teal-600) | #2DD4BF | Actions, highlights — pharmacy-green family, distinct from QB blue |
| `--warn` | #D97706 | #FBBF24 | Low stock, expiring ≤90 d |
| `--danger` | #DC2626 | #F87171 | Expired, errors, voids |
| `--ok` | #16A34A | #4ADE80 | Synced, in stock |

Dark mode ships at MVP (system preference + manual toggle) — the till runs at night.
All pairs meet WCAG AA (≥4.5:1 body text).

## Keyboard shortcuts (POS)

| Key | Action |
|---|---|
| `/` or scan | Focus search / add scanned item |
| `F2` | New sale |
| `F4` | Payment (tender) |
| `F6` | Quantity of selected line |
| `F8` | Line discount (role-gated) |
| `Del` | Remove selected line |
| `F9` | Hold / recall sale |
| `Esc` | Cancel dialog |

## Screen inventory

| # | Screen | Primary persona | Priority |
|---|---|---|---|
| 1 | Login | All | M |
| 2 | ★ POS / Make a Sale | Akosua (Cashier) | M |
| 3 | Payment dialog | Akosua | M |
| 4 | ★ Dashboard | Mr. Boateng (Owner) | M |
| 5 | Products list + product form | Inventory Officer | M |
| 6 | Batches / expiry view | Adjoa (Pharmacist) | M |
| 7 | Purchase orders + receiving | Inventory Officer | M |
| 8 | Stock adjustments | Manager | M |
| 9 | Reports | Owner/Manager | M |
| 10 | Sales history + receipt reprint | Cashier/Manager | M |
| 11 | Suppliers | Inventory Officer | M |
| 12 | Customers | Pharmacist | S |
| 13 | Users & roles | Admin | M |
| 14 | Settings (tax, thresholds, receipt header) | Admin | M |
| 15 | Audit log | Admin/Manager | S |

## ★ Screen 2 — POS / Make a Sale (the screen that wins or loses the client)

```
┌────────────────────────────────────────────────────────────────────────────┐
│ PharmaTrack   ● ONLINE   ⇅ 0 unsynced        Akosua (Cashier)   [Sign out] │
├──────────────────────────────────────────────┬─────────────────────────────┤
│  🔍 Scan barcode or type name / generic…     │  SALE #—  (new)             │
│  ┌────────────────────────────────────────┐  │  ┌───────────────────────┐  │
│  │ Paracetamol 500mg Tab (Crescent)       │  │  │ Paracetamol 500mg     │  │
│  │   strip GHS 5.00 · tab GHS 0.50        │  │  │  2 strip × 5.00 10.00 │  │
│  │   Stock: 42 strips · exp 03/2027       │  │  │ Amoxicillin 250mg     │  │
│  │ Paracetamol Syrup 125mg/5ml 100ml      │  │  │  1 bottle × 18.00     │  │
│  │   bottle GHS 12.00 · Stock: 8          │  │  │              18.00    │  │
│  │ Para-Extra (Paracetamol+Caffeine)      │  │  ├───────────────────────┤  │
│  │   ⚠ LOW STOCK: 3 packs                 │  │  │ Subtotal        28.00 │  │
│  └────────────────────────────────────────┘  │  │ VAT              0.00 │  │
│  [F6 Qty] [F8 Disc] [Del Remove] [F9 Hold]   │  │ TOTAL   GHS     28.00 │  │
│                                              │  └───────────────────────┘  │
│                                              │  [ F4 · PAYMENT ]           │
└──────────────────────────────────────────────┴─────────────────────────────┘
```
Payment dialog (F4): total, tender buttons `[Cash] [MoMo]`, amount-tendered keypad,
change in 40 px type, `Enter` = confirm & print.

Offline state: top bar turns amber `● OFFLINE — sales are saved locally`, unsynced badge
counts up, everything else behaves identically.

## ★ Screen 4 — Dashboard (owner's morning view, must work on a phone)

```
┌────────────────────────────────────────────┐
│ Today                    Mon 13 Jul 2026   │
│ ┌─────────┐ ┌─────────┐ ┌────────────────┐ │
│ │ SALES   │ │ RECEIPTS│ │ CASH / MOMO    │ │
│ │ GHS 1,240│ │   57    │ │ 980 / 260     │ │
│ └─────────┘ └─────────┘ └────────────────┘ │
│ ⚠ Action needed                            │
│ • 6 products at/below reorder level  [→PO] │
│ • 4 batches expire ≤ 90 days (GHS 310)     │
│ • 1 batch EXPIRED — quarantine now         │
│ 📈 Sales, last 14 days   ▁▂▄▃▅▆▄▇          │
│ 🏆 Top sellers this week: Paracetamol 500, │
│    ORS sachets, Amoxicillin 250            │
└────────────────────────────────────────────┘
```

## Screen 6 — Batches / expiry (pharmacist's compliance view)

Table: product · batch no. · expiry · qty · value at cost · status chip
(`OK / ≤90d amber / ≤30d red / EXPIRED grey`), filterable by window, bulk action
"Quarantine expired" → creates disposal adjustments (approval-gated).

## Screen 7 — Receiving flow (3 steps)

`Select PO → enter per-line: qty received, batch no., expiry (scanner moves focus) →
review & post`. Posting shows the stock-movement summary it will create. Over-receipt
lines highlight amber and request Manager PIN (BR/US-09).

## Primary user flow for the pitch (wireframe walk-through order)

Login → POS sale (scan, 2 units, F4, cash, receipt) → connection drops → second sale
offline → reconnect, badge syncs to 0 → owner dashboard on a phone showing the two sales
and an expiry warning. This 90-second arc demonstrates US-01, 04, 06, 07, 08, 11, 13.
