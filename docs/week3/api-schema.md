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

## auth module

| Method & path | Roles | Request body | Response |
|---|---|---|---|
| `POST /auth/login` | public | `{ username, password }` | `200 { accessToken, refreshToken, user: { id, fullName, role } }` · `423` when locked |
| `POST /auth/refresh` | public | `{ refreshToken }` | `200 { accessToken, refreshToken }` (rotated) |
| `POST /auth/logout` | any | `{ refreshToken }` | `204` (token revoked) |
| `GET /auth/me` | any | — | `200 { id, username, fullName, role }` |

## users module

| Method & path | Roles | Request body | Response |
|---|---|---|---|
| `GET /users` | A, M | — | `200 { data: [User], meta }` |
| `POST /users` | A | `{ username, fullName, phone?, role, password }` | `201 User` |
| `PATCH /users/:id` | A | any of `{ fullName, phone, role, isActive }` | `200 User` |
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
| `GET /catalog/snapshot` | any | `?since=` | `200 { products, units, barcodes, openBatches, version }` — offline cache feed |

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

## notifications, audit, settings

| Method & path | Roles | Request/response |
|---|---|---|
| `GET /notifications` | M+, P | `200 { data: [{id, type, payload, seenAt}] }` |
| `POST /notifications/:id/seen` | M+, P | `204` |
| `GET /audit-logs` | A, M | `?entity=&entityId=&userId=&from=&to=` → `200 { data, meta }` |
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
