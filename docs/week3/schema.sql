-- =============================================================================
-- PharmaTrack — PostgreSQL 17 schema (authoritative DDL)
-- COE 454 Week 3 · Generated as design artifact; production migrations via Prisma
-- Conventions: UUIDv7 PKs (app-generated), money NUMERIC(12,2) GHS,
--              quantities INTEGER in base units, timestamptz everywhere.
--
-- Multi-branch (ADR-010): `branch` is a stock-location dimension, not a tenancy
-- boundary. One database, one shared catalogue, per-branch stock. Tables split
-- into two groups:
--   branch-scoped — batches, stock_movements, stock_adjustments, sales,
--                   purchase_orders, goods_receipts, notifications
--   shared        — products, product_units, product_barcodes, categories,
--                   suppliers, customers, users, settings
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------- 1. Enums ---------------------------------------------------------
CREATE TYPE user_role     AS ENUM ('ADMIN','MANAGER','PHARMACIST','INVENTORY_OFFICER','CASHIER');
CREATE TYPE dosage_form   AS ENUM ('TABLET','CAPSULE','SYRUP','SUSPENSION','INJECTION','CREAM','OINTMENT','DROPS','INHALER','SUPPOSITORY','CONSUMABLE','OTHER');
CREATE TYPE batch_status  AS ENUM ('ACTIVE','EXPIRED','QUARANTINED','DEPLETED');
-- TRANSFER_OUT/TRANSFER_IN land here now rather than via a later ALTER TYPE,
-- which Postgres will not run inside a transaction block (Phase 6 uses them).
CREATE TYPE movement_type AS ENUM ('OPENING','RECEIPT','SALE','RETURN_IN','ADJUSTMENT','DISPOSAL','TRANSFER_OUT','TRANSFER_IN');
CREATE TYPE po_status     AS ENUM ('DRAFT','SENT','PARTIALLY_RECEIVED','RECEIVED','CLOSED','CANCELLED');
CREATE TYPE sale_status   AS ENUM ('COMPLETED','VOIDED');
CREATE TYPE payment_method AS ENUM ('CASH','MOMO','CARD');
CREATE TYPE adjustment_reason AS ENUM ('DAMAGE','THEFT','COUNT_CORRECTION','EXPIRY_DISPOSAL','SUPPLIER_RETURN','OTHER');
CREATE TYPE adjustment_status AS ENUM ('PENDING_APPROVAL','APPROVED','REJECTED');

-- ---------- 2. Branches, people & access -------------------------------------
CREATE TABLE branches (
    id             UUID PRIMARY KEY,
    code           TEXT NOT NULL UNIQUE,               -- 'KUM' — prefixes RCP/PO/GRN numbers
    name           TEXT NOT NULL,
    address        TEXT,
    phone          TEXT,
    receipt_header JSONB,                              -- per-branch; falls back to settings.receipt_header
    is_active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (code = upper(code) AND length(code) BETWEEN 2 AND 6)
);

CREATE TABLE users (
    id            UUID PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,                       -- argon2id
    full_name     TEXT NOT NULL,
    phone         TEXT,
    role          user_role NOT NULL,                  -- global; branch reach comes from user_branches (ADR-010)
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    failed_logins SMALLINT NOT NULL DEFAULT 0,
    locked_until  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by    UUID REFERENCES users(id)
);

-- Which branches a user may act in. A Manager is scoped to their branch(es);
-- ADMIN bypasses this for consolidated reporting only (never for stock writes).
CREATE TABLE user_branches (
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    branch_id  UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    is_default BOOLEAN NOT NULL DEFAULT FALSE,         -- branch pre-selected at login
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, branch_id)
);
-- at most one default branch per user
CREATE UNIQUE INDEX ux_user_default_branch ON user_branches (user_id) WHERE is_default;

CREATE TABLE refresh_tokens (
    id           UUID PRIMARY KEY,
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL UNIQUE,                 -- sha256 of the token
    device_label TEXT,
    expires_at   TIMESTAMPTZ NOT NULL,
    revoked_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_refresh_user ON refresh_tokens (user_id) WHERE revoked_at IS NULL;

-- ---------- 3. Catalogue (shared across branches) -----------------------------
CREATE TABLE categories (
    id         UUID PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,                   -- Medicines, Cosmetics, Food & Drinks…
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE products (
    id                 UUID PRIMARY KEY,
    name               TEXT NOT NULL,                  -- brand/display name
    generic_name       TEXT,
    strength           TEXT,                           -- '500 mg', '125 mg/5 ml'
    form               dosage_form NOT NULL DEFAULT 'OTHER',
    category_id        UUID NOT NULL REFERENCES categories(id),
    base_unit          TEXT NOT NULL,                  -- 'tablet','ml','piece'
    selling_price_base NUMERIC(12,2) NOT NULL CHECK (selling_price_base >= 0),  -- same at every branch (ADR-010)
    reorder_level      INTEGER NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),   -- default; overridable per branch
    vat_applies        BOOLEAN NOT NULL DEFAULT FALSE,
    prescription_only  BOOLEAN NOT NULL DEFAULT FALSE, -- BR-08 flag
    notes              TEXT,
    legacy_item_no     TEXT,                           -- QB POS Item No. (US-16 migration)
    deleted_at         TIMESTAMPTZ,                    -- soft delete (US-03 AC3)
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by         UUID REFERENCES users(id),
    updated_by         UUID REFERENCES users(id)
);
CREATE INDEX ix_products_name_trgm    ON products USING gin (name gin_trgm_ops);
CREATE INDEX ix_products_generic_trgm ON products USING gin (generic_name gin_trgm_ops);
CREATE INDEX ix_products_category     ON products (category_id) WHERE deleted_at IS NULL;

-- Prices are shared, but reorder levels are not: the main branch reorders
-- Paracetamol at 500, the kiosk at 50. Null row ⇒ fall back to products.
CREATE TABLE branch_product_settings (
    branch_id     UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    product_id    UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    reorder_level INTEGER NOT NULL CHECK (reorder_level >= 0),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by    UUID REFERENCES users(id),
    PRIMARY KEY (branch_id, product_id)
);

CREATE TABLE product_units (                            -- US-04 multi-unit packaging
    id             UUID PRIMARY KEY,
    product_id     UUID NOT NULL REFERENCES products(id),
    unit_name      TEXT NOT NULL,                      -- 'carton','pack','strip','tablet'
    factor_to_base INTEGER NOT NULL CHECK (factor_to_base >= 1),
    selling_price  NUMERIC(12,2) NOT NULL CHECK (selling_price >= 0),
    is_active      BOOLEAN NOT NULL DEFAULT TRUE,      -- retired, never edited (US-04 AC3)
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (product_id, unit_name)
);

CREATE TABLE product_barcodes (
    id              UUID PRIMARY KEY,
    product_id      UUID NOT NULL REFERENCES products(id),
    product_unit_id UUID REFERENCES product_units(id), -- carton barcode ≠ strip barcode
    barcode         TEXT NOT NULL UNIQUE,              -- US-03 AC2
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE price_history (                            -- BR-03 versioned prices
    id              UUID PRIMARY KEY,
    product_id      UUID NOT NULL REFERENCES products(id),
    product_unit_id UUID REFERENCES product_units(id),
    old_price       NUMERIC(12,2) NOT NULL,
    new_price       NUMERIC(12,2) NOT NULL,
    changed_by      UUID NOT NULL REFERENCES users(id),
    effective_from  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 4. Suppliers & purchasing ----------------------------------------
CREATE TABLE suppliers (                                -- shared: every branch buys from the same list
    id           UUID PRIMARY KEY,
    name         TEXT NOT NULL,
    contact_name TEXT,
    phone        TEXT,
    email        TEXT,
    address      TEXT,
    deleted_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by   UUID REFERENCES users(id)
);

CREATE TABLE purchase_orders (
    id            UUID PRIMARY KEY,
    po_number     TEXT NOT NULL UNIQUE,                -- 'KUM-PO-2026-0001' — branch-code prefixed
    branch_id     UUID NOT NULL REFERENCES branches(id),  -- destination; the GRN must match
    supplier_id   UUID NOT NULL REFERENCES suppliers(id),
    status        po_status NOT NULL DEFAULT 'DRAFT',
    expected_date DATE,
    notes         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by    UUID NOT NULL REFERENCES users(id)
);
CREATE INDEX ix_po_branch ON purchase_orders (branch_id, created_at DESC);

CREATE TABLE purchase_order_items (
    id           UUID PRIMARY KEY,
    po_id        UUID NOT NULL REFERENCES purchase_orders(id),
    product_id   UUID NOT NULL REFERENCES products(id),
    qty_base     INTEGER NOT NULL CHECK (qty_base > 0),
    unit_cost    NUMERIC(12,4) NOT NULL CHECK (unit_cost >= 0),  -- per base unit
    qty_received INTEGER NOT NULL DEFAULT 0 CHECK (qty_received >= 0),
    UNIQUE (po_id, product_id)
);

CREATE TABLE goods_receipts (
    id          UUID PRIMARY KEY,
    grn_number  TEXT NOT NULL UNIQUE,                  -- 'KUM-GRN-2026-0001'
    branch_id   UUID NOT NULL REFERENCES branches(id), -- receiving branch; enforced = po.branch_id
    po_id       UUID REFERENCES purchase_orders(id),   -- nullable: direct receipt
    supplier_id UUID NOT NULL REFERENCES suppliers(id),
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    received_by UUID NOT NULL REFERENCES users(id),
    notes       TEXT
);
CREATE INDEX ix_grn_branch ON goods_receipts (branch_id, received_at DESC);

CREATE TABLE goods_receipt_items (
    id           UUID PRIMARY KEY,
    receipt_id   UUID NOT NULL REFERENCES goods_receipts(id),
    product_id   UUID NOT NULL REFERENCES products(id),
    batch_id     UUID NOT NULL,                        -- FK added after batches
    qty_base     INTEGER NOT NULL CHECK (qty_base > 0),
    unit_cost    NUMERIC(12,4) NOT NULL CHECK (unit_cost >= 0)
);

-- ---------- 5. Inventory (branch-scoped) --------------------------------------
CREATE TABLE batches (                                  -- US-05 batch & expiry
    id           UUID PRIMARY KEY,
    branch_id    UUID NOT NULL REFERENCES branches(id),
    product_id   UUID NOT NULL REFERENCES products(id),
    batch_number TEXT NOT NULL,
    expiry_date  DATE NOT NULL,
    qty_on_hand  INTEGER NOT NULL DEFAULT 0,            -- may go negative ONLY via offline sync (ADR-006)
    unit_cost    NUMERIC(12,4) NOT NULL DEFAULT 0,      -- weighted average, per base unit
    status       batch_status NOT NULL DEFAULT 'ACTIVE',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- branch-scoped: the same supplier batch legitimately lands at two branches
    UNIQUE (branch_id, product_id, batch_number, expiry_date)
);
CREATE INDEX ix_batches_fefo ON batches (branch_id, product_id, expiry_date) WHERE status = 'ACTIVE';

ALTER TABLE goods_receipt_items
    ADD CONSTRAINT fk_gri_batch FOREIGN KEY (batch_id) REFERENCES batches(id);

CREATE TABLE stock_adjustments (                        -- US-12
    id            UUID PRIMARY KEY,
    branch_id     UUID NOT NULL REFERENCES branches(id),
    product_id    UUID NOT NULL REFERENCES products(id),
    batch_id      UUID NOT NULL REFERENCES batches(id),
    qty_delta     INTEGER NOT NULL CHECK (qty_delta <> 0),
    reason        adjustment_reason NOT NULL,
    note          TEXT,
    status        adjustment_status NOT NULL DEFAULT 'PENDING_APPROVAL',
    requested_by  UUID NOT NULL REFERENCES users(id),
    approved_by   UUID REFERENCES users(id),            -- must be a Manager OF THIS BRANCH
    decided_at    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (status <> 'APPROVED' OR approved_by IS NOT NULL)
);
CREATE INDEX ix_adj_branch ON stock_adjustments (branch_id, created_at DESC);

CREATE TABLE stock_movements (                          -- append-only ledger; NEVER updated
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    branch_id    UUID NOT NULL REFERENCES branches(id),
    product_id   UUID NOT NULL REFERENCES products(id),
    batch_id     UUID NOT NULL REFERENCES batches(id),
    qty_delta    INTEGER NOT NULL CHECK (qty_delta <> 0),  -- + in, − out (base units)
    type         movement_type NOT NULL,
    ref_type     TEXT NOT NULL,                         -- 'sale','goods_receipt','stock_adjustment','sale_return','stock_transfer'
    ref_id       UUID NOT NULL,
    unit_cost    NUMERIC(12,4) NOT NULL DEFAULT 0,      -- cost snapshot at movement time
    performed_by UUID NOT NULL REFERENCES users(id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_mov_product ON stock_movements (branch_id, product_id, created_at DESC);
CREATE INDEX ix_mov_ref     ON stock_movements (ref_type, ref_id);

-- ---------- 6. Customers & sales ----------------------------------------------
CREATE TABLE customers (                                -- shared: a customer may shop at any branch
    id         UUID PRIMARY KEY,
    full_name  TEXT NOT NULL,
    phone      TEXT UNIQUE,
    notes      TEXT,                                    -- access: PHARMACIST+ (US-15/Act 843)
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sales (
    id             UUID PRIMARY KEY,
    branch_id      UUID NOT NULL REFERENCES branches(id),
    client_sale_id UUID NOT NULL UNIQUE,               -- idempotent offline sync (ADR-006)
    receipt_number TEXT NOT NULL UNIQUE,               -- 'KUM-RCP-2026-000123', server-assigned
    cashier_id     UUID NOT NULL REFERENCES users(id),
    customer_id    UUID REFERENCES customers(id),
    subtotal       NUMERIC(12,2) NOT NULL CHECK (subtotal >= 0),
    discount_total NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (discount_total >= 0),
    vat_total      NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (vat_total >= 0),
    total          NUMERIC(12,2) NOT NULL CHECK (total >= 0),
    status         sale_status NOT NULL DEFAULT 'COMPLETED',
    synced_offline BOOLEAN NOT NULL DEFAULT FALSE,     -- true if arrived via sync queue
    sold_at        TIMESTAMPTZ NOT NULL,               -- client timestamp (offline-true)
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()  -- server receive time
);
CREATE INDEX ix_sales_sold_at ON sales (branch_id, sold_at DESC);
CREATE INDEX ix_sales_cashier ON sales (branch_id, cashier_id, sold_at DESC);

CREATE TABLE sale_items (
    id              UUID PRIMARY KEY,
    sale_id         UUID NOT NULL REFERENCES sales(id),
    product_id      UUID NOT NULL REFERENCES products(id),
    product_unit_id UUID REFERENCES product_units(id), -- null ⇒ base unit
    batch_id        UUID NOT NULL REFERENCES batches(id),
    quantity        INTEGER NOT NULL CHECK (quantity > 0),   -- in the sold unit
    qty_base        INTEGER NOT NULL CHECK (qty_base > 0),   -- converted snapshot
    unit_price      NUMERIC(12,2) NOT NULL CHECK (unit_price >= 0),  -- snapshot
    discount        NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
    line_total      NUMERIC(12,2) NOT NULL CHECK (line_total >= 0),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_sale_items_sale    ON sale_items (sale_id);
CREATE INDEX ix_sale_items_product ON sale_items (product_id, created_at);

CREATE TABLE payments (
    id          UUID PRIMARY KEY,
    sale_id     UUID NOT NULL REFERENCES sales(id),
    method      payment_method NOT NULL,
    amount      NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    tendered    NUMERIC(12,2),
    change_due  NUMERIC(12,2),
    momo_ref    TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sale_returns (                             -- US-14
    id           UUID PRIMARY KEY,
    sale_id      UUID NOT NULL REFERENCES sales(id),    -- branch inherited from the sale
    reason       TEXT NOT NULL,
    refund_total NUMERIC(12,2) NOT NULL CHECK (refund_total >= 0),
    approved_by  UUID NOT NULL REFERENCES users(id),    -- PHARMACIST/MANAGER (AC2)
    processed_by UUID NOT NULL REFERENCES users(id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sale_return_items (
    id             UUID PRIMARY KEY,
    sale_return_id UUID NOT NULL REFERENCES sale_returns(id),
    sale_item_id   UUID NOT NULL REFERENCES sale_items(id),
    qty_base       INTEGER NOT NULL CHECK (qty_base > 0),
    restock        BOOLEAN NOT NULL DEFAULT TRUE        -- false ⇒ disposal adjustment
);

-- ---------- 7. Cross-cutting ---------------------------------------------------
CREATE TABLE audit_logs (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    UUID REFERENCES users(id),
    branch_id  UUID REFERENCES branches(id),            -- nullable: global actions have no branch
    action     TEXT NOT NULL,                           -- 'sale.void','product.price_change','auth.lockout'…
    entity     TEXT NOT NULL,
    entity_id  TEXT NOT NULL,
    before     JSONB,
    after      JSONB,
    ip_address INET,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_audit_entity ON audit_logs (entity, entity_id, created_at DESC);
CREATE INDEX ix_audit_branch ON audit_logs (branch_id, created_at DESC);

CREATE TABLE settings (                                 -- global; branch identity lives on branches
    key        TEXT PRIMARY KEY,                        -- 'vat_rate','expiry_warn_days','adjust_approval_threshold','receipt_header'
    value      JSONB NOT NULL,
    updated_by UUID REFERENCES users(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
    id         UUID PRIMARY KEY,
    branch_id  UUID REFERENCES branches(id),            -- nullable ⇒ system-wide; else only that branch sees it
    type       TEXT NOT NULL,                           -- 'LOW_STOCK','EXPIRY_90','EXPIRED','NEG_STOCK_EXCEPTION'
    payload    JSONB NOT NULL,
    seen_at    TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_notif_branch ON notifications (branch_id, created_at DESC) WHERE seen_at IS NULL;

-- ---------- 8. Reporting views (branch-aware) ------------------------------------
-- CROSS JOIN branches × products, not a filtered LEFT JOIN: a product with zero
-- stock at a branch must still surface there as low stock. Filtering batches in
-- WHERE instead of the JOIN condition would silently drop exactly those rows.
CREATE VIEW v_stock_on_hand AS
SELECT br.id AS branch_id, br.code AS branch_code,
       p.id AS product_id, p.name, p.base_unit,
       COALESCE(SUM(b.qty_on_hand) FILTER (WHERE b.status = 'ACTIVE'), 0) AS qty_base,
       COALESCE(SUM(b.qty_on_hand * b.unit_cost) FILTER (WHERE b.status = 'ACTIVE'), 0)::numeric(14,2) AS value_at_cost,
       COALESCE(bps.reorder_level, p.reorder_level) AS reorder_level
FROM branches br
CROSS JOIN products p
LEFT JOIN batches b
       ON b.product_id = p.id AND b.branch_id = br.id
LEFT JOIN branch_product_settings bps
       ON bps.product_id = p.id AND bps.branch_id = br.id
WHERE p.deleted_at IS NULL AND br.is_active
GROUP BY br.id, br.code, p.id, bps.reorder_level;

CREATE VIEW v_low_stock AS
SELECT * FROM v_stock_on_hand WHERE qty_base <= reorder_level;

CREATE VIEW v_expiring_batches AS
SELECT b.*, br.code AS branch_code, p.name AS product_name,
       (b.expiry_date - CURRENT_DATE) AS days_to_expiry,
       (b.qty_on_hand * b.unit_cost)::numeric(14,2) AS value_at_risk
FROM batches b
JOIN products p ON p.id = b.product_id
JOIN branches br ON br.id = b.branch_id
WHERE b.status = 'ACTIVE' AND b.qty_on_hand > 0
  AND b.expiry_date <= CURRENT_DATE + INTERVAL '90 days';

CREATE VIEW v_daily_sales AS
SELECT branch_id, sold_at::date AS day, COUNT(*) AS receipts,
       SUM(total) AS gross, SUM(vat_total) AS vat, SUM(discount_total) AS discounts
FROM sales WHERE status = 'COMPLETED'
GROUP BY branch_id, sold_at::date;

CREATE VIEW v_shrinkage AS
SELECT sa.branch_id, sa.reason, COUNT(*) AS adjustments, SUM(sa.qty_delta) AS qty_base,
       SUM(sa.qty_delta * b.unit_cost)::numeric(14,2) AS value
FROM stock_adjustments sa JOIN batches b ON b.id = sa.batch_id
WHERE sa.status = 'APPROVED' AND sa.qty_delta < 0
GROUP BY sa.branch_id, sa.reason;

-- =============================================================================
-- Stock transfers between branches (ADR-010, Phase 6)
--
-- Deliberately two-sided: dispatch only touches the source branch, receipt only
-- touches the destination. Neither half is a cross-branch write, so the branch
-- isolation model holds without an escape hatch — the goods are handed over in
-- the real world, and the two halves are recorded by the staff at each end.
--
-- Valuation policy: dispatched-but-unreceived stock leaves the source's
-- sellable shelf (it cannot be sold twice) but remains the source branch's
-- asset until receipt. v_in_transit exposes that gap so it is neither
-- double-counted nor invisible.
-- =============================================================================

CREATE TYPE transfer_status AS ENUM ('DRAFT','IN_TRANSIT','RECEIVED','CANCELLED');

CREATE TABLE stock_transfers (
    id              UUID PRIMARY KEY,
    transfer_number TEXT NOT NULL UNIQUE,                  -- 'ACC-TRF-2026-0001', source branch code
    from_branch_id  UUID NOT NULL REFERENCES branches(id),
    to_branch_id    UUID NOT NULL REFERENCES branches(id),
    status          transfer_status NOT NULL DEFAULT 'DRAFT',
    notes           TEXT,
    created_by      UUID NOT NULL REFERENCES users(id),
    dispatched_by   UUID REFERENCES users(id),
    dispatched_at   TIMESTAMPTZ,
    received_by     UUID REFERENCES users(id),
    received_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (from_branch_id <> to_branch_id),
    CHECK (status <> 'IN_TRANSIT' OR dispatched_by IS NOT NULL),
    CHECK (status <> 'RECEIVED'   OR received_by   IS NOT NULL)
);
CREATE INDEX ix_transfer_from ON stock_transfers (from_branch_id, created_at DESC);
CREATE INDEX ix_transfer_to   ON stock_transfers (to_branch_id, created_at DESC);

CREATE TABLE stock_transfer_items (
    id              UUID PRIMARY KEY,
    transfer_id     UUID NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
    product_id      UUID NOT NULL REFERENCES products(id),
    source_batch_id UUID NOT NULL REFERENCES batches(id),   -- the physical batch leaving
    dest_batch_id   UUID REFERENCES batches(id),            -- created/topped up on receipt
    -- Denormalised at dispatch: the receiving branch cannot read the source
    -- branch's batch row (branch isolation), and the transfer document should
    -- record what was actually sent regardless of the source batch's later state.
    batch_number    TEXT NOT NULL,
    expiry_date     DATE NOT NULL,
    qty_base        INTEGER NOT NULL CHECK (qty_base > 0),
    qty_received    INTEGER NOT NULL DEFAULT 0 CHECK (qty_received >= 0),
    unit_cost       NUMERIC(12,4) NOT NULL DEFAULT 0,       -- carried across, so valuation follows the goods
    CHECK (qty_received <= qty_base),
    UNIQUE (transfer_id, source_batch_id)
);
CREATE INDEX ix_transfer_items_transfer ON stock_transfer_items (transfer_id);

-- Dispatched but not yet received: still the source branch's asset.
CREATE VIEW v_in_transit AS
SELECT t.id AS transfer_id, t.transfer_number,
       t.from_branch_id, t.to_branch_id,
       src.code AS from_branch_code, dst.code AS to_branch_code,
       ti.product_id, p.name AS product_name,
       (ti.qty_base - ti.qty_received) AS qty_base,
       ((ti.qty_base - ti.qty_received) * ti.unit_cost)::numeric(14,2) AS value_in_transit,
       t.dispatched_at
FROM stock_transfers t
JOIN stock_transfer_items ti ON ti.transfer_id = t.id
JOIN products p  ON p.id = ti.product_id
JOIN branches src ON src.id = t.from_branch_id
JOIN branches dst ON dst.id = t.to_branch_id
WHERE t.status = 'IN_TRANSIT' AND ti.qty_base > ti.qty_received;
