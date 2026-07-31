# API Schema

**COE 454 — Week 3 Deliverable 3** · REST over HTTPS · Base path `/api/v1`
**Owner:** Backend Lead

## Conventions

- **Auth:** `Authorization: Bearer <access JWT>` on everything except `POST /auth/login`
  and `POST /auth/refresh`. Role requirements listed per endpoint
  (A=Admin, M=Manager, P=Pharmacist, I=Inventory Officer, C=Cashier; "M+" means M or A).
- **Envelope:** success → resource or `{ "data": [...], "meta": { "page", "pageSize", "total" } }`;
  error → `{ "error": { "code": "BATCH_EXPIRED", "message": "…", "details": {} } }` with
  proper HTTP status (400 validation, 401 auth, 403 role, 404, 409 conflict, 422 domain rule).
- **Lists:** `?page=&pageSize=&q=&sort=` standard; all lists paginated.
- **IDs:** UUIDs generated client-side where offline matters (sales), server-side otherwise.
- **Validation:** every body validated by DTO (class-validator); unknown fields rejected.
- **Branch (ADR-010):** every request acts in exactly one branch, carried in the access
  token — never a client-supplied header or query param. Branch-scoped reads are filtered
  automatically; branch-scoped writes are refused outside a branch. An ADMIN may hold a
  *consolidated* token (`branch: null`) which reads across all branches and cannot write.
  Cross-branch access returns `404`, not `403`: a branch is not told what another holds.

## auth module

| Method & path | Roles | Request body | Response |
|---|---|---|---|
| `POST /auth/login` | public | `{ username, password }` | `200 { accessToken, refreshToken, user: { id, fullName, role, activeBranch, branches } }` · `423` when locked · `401 NO_BRANCH_ASSIGNED` if the account has no branch |
| `POST /auth/refresh` | public | `{ refreshToken }` | `200 { accessToken, refreshToken }` (rotated) |
| `POST /auth/logout` | any | `{ refreshToken }` | `204` (token revoked) |
| `GET /auth/me` | any | — | `200 { id, username, fullName, role, activeBranch, branches }` |
| `POST /auth/switch-branch` | any | `{ branchId }` or `{ branchId: null }` | `200 { accessToken, activeBranch, branches }` — re-issues the access token against another branch; the refresh token is unchanged. `401 BRANCH_FORBIDDEN` if not assigned; `401 CONSOLIDATED_FORBIDDEN` for `null` below ADMIN |

Branch lives in the signed token, so switching is a server round-trip rather than a
client-side flag — a header the client could set would be one missed validation away from
a cross-branch write (ADR-010).

## branches module

| Method & path | Roles | Request body | Response |
|---|---|---|---|
| `GET /branches` | any | `?includeInactive=true` | `200 [{ id, code, name, address, phone, isActive }]` — readable by all: the transfer destination picker and user-assignment UI need it. Seeing that a shop exists is not the same as reading its stock. |
| `POST /branches` | A | `{ code, name, address?, phone?, receiptHeader? }` | `201 Branch` · `400 BRANCH_CODE_TAKEN` |
| `PATCH /branches/:id` | A | subset of `{ name, address, phone, isActive, receiptHeader }` | `200 Branch` · `400 BRANCH_CODE_IMMUTABLE` — the code is embedded in every document number already issued |

## users module

| Method & path | Roles | Request body | Response |
|---|---|---|---|
| `GET /users` | A, M | — | `200 { data: [User], meta }` |
| `POST /users` | A | `{ username, fullName, phone?, role, password, branchIds, defaultBranchId? }` | `201 User` · `400 BRANCH_UNKNOWN` · `400 DEFAULT_BRANCH_NOT_ASSIGNED`. `branchIds` is **required** — an account with no branch cannot sign in |
| `PATCH /users/:id` | A | any of `{ fullName, phone, role, isActive, branchIds, defaultBranchId }` | `200 User` — supplying `branchIds` replaces the assignment wholesale and revokes the user's refresh tokens, since their token still names the old branch |
| `POST /users/:id/reset-password` | A | `{ newPassword }` | `204` |

## catalog module

| Method & path | Roles | Request body | Response |
|---|---|---|---|
| `GET /products` | any | `?q=` (name/generic/barcode) `&categoryId=&lowStock=` | `200 { data: [ProductSummary], meta }` — <300 ms target |
| `GET /products/:id` | any | — | `200 Product` (incl. units, barcodes, stock breakdown) |
| `POST /products` | I, M+ | `{ name, genericName?, strength?, form, categoryId, baseUnit, sellingPriceBase, reorderLevel, vatApplies, prescriptionOnly, units?: [{unitName, factorToBase, sellingPrice}], barcodes?: [string] }` | `201 Product` · `409` duplicate barcode |
| `PATCH /products/:id` | I, M+ | subset of above (price changes M+ only → price_history) | `200 Product` |
| `DELETE /products/:id` | M+ | — | `204` (soft delete) |
| `POST /products/:id/units` | M+ | `{ unitName, factorToBase, sellingPrice }` | `201 ProductUnit` |
| `POST /products/import` | A | multipart CSV (QB export) | `200 { imported, skipped, errors: [{row, message}] }` (US-16) |
| `GET /categories` / `POST /categories` | any / M+ | `{ name }` | `200 [Category]` / `201 Category` |
| `GET /barcodes/:code` | any | — | `200 { product, unit }` · `404` → POS prompts search (US-06 AC1) |

## inventory module

| Method & path | Roles | Request body | Response |
|---|---|---|---|
| `GET /batches` | any | `?productId=&expiringWithinDays=&status=` | `200 { data: [Batch], meta }` |
| `GET /inventory/stock` | any | `?lowStock=true` | `200 [ { productId, name, qtyBase, unitBreakdown, valueAtCost, reorderLevel } ]` |
| `POST /adjustments` | I, P, M+ | `{ productId, batchId, qtyDelta, reason, note? }` | `201 Adjustment` (status per threshold — BR-05) |
| `POST /adjustments/:id/approve` | M+ | `{ decision: "APPROVED"\|"REJECTED", note? }` | `200 Adjustment` (approval posts movement) |
| `GET /adjustments` | M+ | `?status=` | `200 { data, meta }` |
| `GET /inventory/movements` | M+ | `?productId=&from=&to=&type=` | `200 { data: [Movement], meta }` |

All rows above are the active branch's only. `GET /inventory/stock` reads
`v_stock_on_hand`, which carries one row per branch × product; in consolidated mode the
branches are summed rather than listed separately.

## transfers module (ADR-010)

A transfer is **two one-sided operations**: the sender can only dispatch, the receiver can
only receive. That mirrors the physical handover and means no transfer ever writes across
a branch boundary. A branch sees only transfers it is a party to (`from` or `to`);
anything else is `404`.

| Method & path | Roles | Request body | Response |
|---|---|---|---|
| `GET /transfers` | I, P, M+ | `?status=` | `200 { data: [Transfer], meta }` — where this branch is sender or receiver |
| `GET /transfers/in-transit` | M+ | — | `200 { rows, totalValue }` — dispatched but unreceived; still the **sender's** asset |
| `GET /transfers/:id` | I, P, M+ | — | `200 Transfer` · `404` if this branch is not a party |
| `POST /transfers` | I, M+ | `{ toBranchId, notes?, items: [{ sourceBatchId, qtyBase }] }` | `201 Transfer` (DRAFT) · `422 SAME_BRANCH` · `422 BATCH_UNKNOWN` (batch not active stock **at this branch**) · `422 INSUFFICIENT_STOCK` |
| `POST /transfers/:id/dispatch` | I, M+ | — | `200 Transfer` (→ IN_TRANSIT). Sender only. Decrements source batches, writes `TRANSFER_OUT`, notifies the destination. Stock is re-checked here, not trusted from draft time · `422 TRANSFER_NOT_DRAFT` · `422 INSUFFICIENT_STOCK` |
| `POST /transfers/:id/receive` | I, M+ | `{ items?: [{ itemId, qtyReceived }], notes? }` | `200 Transfer` (→ RECEIVED). Receiver only. Creates or tops up the destination batch carrying batch identity and unit cost across, writes `TRANSFER_IN`. Omitted quantities default to what was sent · `422 RECEIVED_EXCEEDS_SENT` · `422 TRANSFER_NOT_IN_TRANSIT` |
| `POST /transfers/:id/cancel` | M+ | — | `200 Transfer` (→ CANCELLED). Drafts only — once goods are moving they must be received · `422 TRANSFER_NOT_DRAFT` |

A short receipt is normal, not an error: only what arrived lands on the destination shelf,
the shortfall stays visible on the transfer, and a `TRANSFER_SHORT_RECEIPT` notification
goes to the sending branch. Nothing is written off silently.

## suppliers & purchasing modules

| Method & path | Roles | Request body | Response |
|---|---|---|---|
| `GET /suppliers` / `POST /suppliers` | I, M+ | `{ name, contactName?, phone?, email?, address? }` | `200/201` |
| `PATCH /suppliers/:id` / `DELETE` | I, M+ / M+ | subset | `200` / `204` (soft) |
| `GET /purchase-orders` | I, M+ | `?status=&supplierId=` | `200 { data, meta }` |
| `POST /purchase-orders` | I, M+ | `{ supplierId, expectedDate?, items: [{productId, qtyBase, unitCost}], notes? }` | `201 PO` (status DRAFT) |
| `POST /purchase-orders/:id/send` | I, M+ | — | `200 PO` (→ SENT) |
| `POST /purchase-orders/from-suggestions` | I, M+ | `{ productIds: [] }` | `201 PO` draft from low-stock list (US-10 AC2) |
| `POST /goods-receipts` | I, M+ | `{ poId?, supplierId, items: [{productId, qtyBase, unitCost, batchNumber, expiryDate}], notes? }` | `201 GRN` — creates/updates batches + RECEIPT movements atomically · `422 OVER_RECEIPT` without Manager approval flag (US-09 AC2) |
| `GET /goods-receipts` | I, M+ | `?poId=` | `200 { data, meta }` |

An order is raised for the branch that will receive it, and the GRN must match:
receiving against another branch's order returns `422 PO_BRANCH_MISMATCH`, otherwise the
stock lands at the wrong shop and the order never reconciles. PO and GRN numbers are
branch-prefixed (`KUM-PO-2026-0001`). `POST /purchase-orders/from-suggestions` drafts from
this branch's low-stock list only.

## sales module (POS + offline sync)

| Method & path | Roles | Request body | Response |
|---|---|---|---|
| `POST /sales` | C, P, M+ | `SaleCreate` (below) | `201 Sale` (receipt number assigned) · `409` duplicate `clientSaleId` returns the existing sale · `422 BATCH_EXPIRED` |
| `POST /sync/sales` | C, P, M+ | `{ sales: [SaleCreate, …] }` (queued offline) | `200 { results: [{clientSaleId, status: "created"\|"duplicate"\|"error", receiptNumber?, error?}] }` — idempotent (ADR-006) |
| `GET /sales` | P, M+ (C: own, today) | `?from=&to=&cashierId=&q=receiptNo` | `200 { data, meta }` |
| `GET /sales/:id` | as above | — | `200 Sale` (full lines + payments) |
| `GET /sales/:id/receipt` | as above | — | `200` print-ready payload (reprint flagged — US-07 AC2) |
| `POST /sales/:id/void` | M+ | `{ reason }` | `200 Sale` (compensating movements, audited) |
| `POST /returns` | C, P (approval P/M — US-14) | `{ saleId, items: [{saleItemId, qtyBase, restock}], reason, approverPin }` | `201 Return` |
| `GET /catalog/snapshot` | any | `?since=` | `200 { products, units, barcodes, openBatches, version }` — offline cache feed, **scoped to the active branch**: `qtyOnHand` and `nearestExpiry` describe this shop's shelves only |

Receipt numbers are branch-code prefixed (`KUM-RCP-2026-000123`) off a single global
sequence, so they remain globally unique — which the offline dedupe relies on — while
still reading as belonging to a shop. Lookup by the bare `RCP-…` portion still matches.

`POST /sync/sales` accepts an optional `branchId` per queued sale, stamped at the till
when the sale was taken. A sale whose branch does not match the token is **quarantined,
not dropped** — the money was already taken — returning `status: "error"` with
`BRANCH_MISMATCH` and raising a `SYNC_BRANCH_MISMATCH` notification for a manager. The
client leaves it queued.

```jsonc
// SaleCreate
{
  "clientSaleId": "0198a7ff-…",       // UUIDv7, generated at the till
  "soldAt": "2026-07-13T18:42:10Z",   // client clock (offline-true)
  "customerId": null,
  "items": [
    { "productId": "…", "productUnitId": "…", "quantity": 2,
      "unitPrice": 5.00, "discount": 0 }      // batch chosen server-side by FEFO
  ],
  "payments": [ { "method": "CASH", "amount": 28.00, "tendered": 30.00 } ]
}
```

## customers module

| Method & path | Roles | Request body | Response |
|---|---|---|---|
| `GET /customers` / `POST /customers` | P, M+ | `{ fullName, phone? }` | `200/201` |
| `GET /customers/:id/history` | P, M+ | — | `200 { data: [SaleSummary], meta }` |

## reporting module (reads views only)

| Method & path | Roles | Response |
|---|---|---|
| `GET /reports/daily?date=` | M+ (Z-report), C (own till) | `200 { gross, receipts, byMethod, byCashier, vat, refunds }` |
| `GET /reports/sales?from=&to=&groupBy=product\|category\|day` | M+ | `200 { rows }` |
| `GET /reports/stock-valuation` | M+ | `200 { rows, totalValue }` |
| `GET /reports/expiring?window=30\|60\|90` | P, M+ | `200 { rows, valueAtRisk }` |
| `GET /reports/shrinkage?from=&to=` | M+ | `200 { rows }` |
| `GET /reports/:name/export?format=csv\|pdf` | M+ | `200` file stream (US-13 AC3) |

Every report is scoped to the active branch. An ADMIN holding a consolidated token
(`POST /auth/switch-branch` with `branchId: null`) gets the same reports across all
branches; stock valuation sums branches rather than listing a product once per shop.

## notifications, audit, settings

| Method & path | Roles | Request/response |
|---|---|---|
| `GET /notifications` | M+, P | `200 { data: [{id, type, branchId, payload, seenAt}] }` — this branch's plus system-wide (`branchId: null`) |
| `POST /notifications/:id/seen` | M+, P | `204` |
| `GET /audit-logs` | A, M | `?entity=&entityId=&userId=&branchId=&from=&to=` → `200 { data, meta }` |
| `GET /settings` / `PATCH /settings` | A | `{ key: value, … }` → `200` (each change audited) |
| `GET /health` | public | `200 { status: "ok", db: "ok", version }` — uptime checks & Week 7 load test |

## Cross-cutting behaviors

- **Idempotency:** `POST /sales` and `POST /sync/sales` are idempotent on
  `clientSaleId`; retries are safe by design.
- **Transactions:** sale creation = one DB transaction: FEFO batch selection with
  `FOR UPDATE` → movements → batch totals → sale + items + payments (NFR-05).
- **Audit interceptor:** mutating endpoints emit audit entries with before/after diffs.
- **Rate limits:** `/auth/login` 5/min/IP (US-01 AC2); global 100 req/min/user.
- **Scheduled jobs:** nightly batch-status sweep (expired → `EXPIRED`, notify);
  15-min low-stock scan → notifications; Week 5 adds SMS digest via Africa's Talking.
  Jobs run outside any request, so they have no branch context and sweep every branch;
  low-stock dedupe is keyed on `(branch, product)` so a shortage at one shop does not
  silence the same shortage at another.
- **Branch enforcement (ADR-010):** a Prisma client extension over an `AsyncLocalStorage`
  request context filters branch-scoped models automatically, so a forgotten `where`
  clause cannot leak across shops. It cannot see raw SQL — the FEFO allocator and the
  view-backed reports carry their branch predicate by hand, and
  `test/branch-isolation.e2e-spec.ts` covers those paths.

## Branch-related error codes

| Code | Status | Meaning |
|---|---|---|
| `BRANCH_REQUIRED` | 422 | The action needs an active branch; the token is consolidated |
| `BRANCH_FORBIDDEN` | 401 | The user is not assigned to the requested branch |
| `CONSOLIDATED_FORBIDDEN` | 401 | Only ADMIN may view all branches at once |
| `NO_BRANCH_ASSIGNED` | 401 | The account has no branch, so it cannot sign in |
| `NO_BRANCH_CONFIGURED` | 401 | No active branch exists yet — create one first |
| `BRANCH_UNKNOWN` | 400/422 | Branch or batch does not exist, or is not this branch's stock |
| `BRANCH_CODE_TAKEN` | 400 | Another branch already uses that code |
| `BRANCH_CODE_IMMUTABLE` | 400 | The code is embedded in issued document numbers |
| `DEFAULT_BRANCH_NOT_ASSIGNED` | 400 | The sign-in branch must be one of the assigned branches |
| `PO_BRANCH_MISMATCH` | 422 | Goods received against an order raised for another branch |
| `SAME_BRANCH` | 422 | A transfer's source and destination must differ |
| `TRANSFER_NOT_DRAFT` / `TRANSFER_NOT_IN_TRANSIT` | 422 | Wrong state for the requested step |
| `RECEIVED_EXCEEDS_SENT` | 422 | Cannot receive more than was dispatched |

Reading another branch's record returns `404`, not `403` — a branch is never told what
another holds.
