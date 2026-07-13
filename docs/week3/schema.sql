-- =============================================================================
-- PharmaTrack — PostgreSQL 16 schema (authoritative DDL)
-- COE 454 Week 3 · Generated as design artifact; production migrations via Prisma
-- Conventions: UUIDv7 PKs (app-generated), money NUMERIC(12,2) GHS,
--              quantities INTEGER in base units, timestamptz everywhere.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------- 1. Enums ---------------------------------------------------------
CREATE TYPE user_role     AS ENUM ('ADMIN','MANAGER','PHARMACIST','INVENTORY_OFFICER','CASHIER');
CREATE TYPE dosage_form   AS ENUM ('TABLET','CAPSULE','SYRUP','SUSPENSION','INJECTION','CREAM','OINTMENT','DROPS','INHALER','SUPPOSITORY','CONSUMABLE','OTHER');
CREATE TYPE batch_status  AS ENUM ('ACTIVE','EXPIRED','QUARANTINED','DEPLETED');
CREATE TYPE movement_type AS ENUM ('OPENING','RECEIPT','SALE','RETURN_IN','ADJUSTMENT','DISPOSAL');
CREATE TYPE po_status     AS ENUM ('DRAFT','SENT','PARTIALLY_RECEIVED','RECEIVED','CLOSED','CANCELLED');
CREATE TYPE sale_status   AS ENUM ('COMPLETED','VOIDED');
CREATE TYPE payment_method AS ENUM ('CASH','MOMO','CARD');
CREATE TYPE adjustment_reason AS ENUM ('DAMAGE','THEFT','COUNT_CORRECTION','EXPIRY_DISPOSAL','SUPPLIER_RETURN','OTHER');
CREATE TYPE adjustment_status AS ENUM ('PENDING_APPROVAL','APPROVED','REJECTED');

-- ---------- 2. People & access ----------------------------------------------
CREATE TABLE users (
    id            UUID PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,                       -- argon2id
    full_name     TEXT NOT NULL,
    phone         TEXT,
    role          user_role NOT NULL,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    failed_logins SMALLINT NOT NULL DEFAULT 0,
    locked_until  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by    UUID REFERENCES users(id)
);

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

-- ---------- 3. Catalogue ------------------------------------------------------
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
    selling_price_base NUMERIC(12,2) NOT NULL CHECK (selling_price_base >= 0),
    reorder_level      INTEGER NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
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
CREATE TABLE suppliers (
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
    po_number     TEXT NOT NULL UNIQUE,                -- 'PO-2026-0001'
    supplier_id   UUID NOT NULL REFERENCES suppliers(id),
    status        po_status NOT NULL DEFAULT 'DRAFT',
    expected_date DATE,
    notes         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by    UUID NOT NULL REFERENCES users(id)
);

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
    grn_number  TEXT NOT NULL UNIQUE,                  -- 'GRN-2026-0001'
    po_id       UUID REFERENCES purchase_orders(id),   -- nullable: direct receipt
    supplier_id UUID NOT NULL REFERENCES suppliers(id),
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    received_by UUID NOT NULL REFERENCES users(id),
    notes       TEXT
);

CREATE TABLE goods_receipt_items (
    id           UUID PRIMARY KEY,
    receipt_id   UUID NOT NULL REFERENCES goods_receipts(id),
    product_id   UUID NOT NULL REFERENCES products(id),
    batch_id     UUID NOT NULL,                        -- FK added after batches
    qty_base     INTEGER NOT NULL CHECK (qty_base > 0),
    unit_cost    NUMERIC(12,4) NOT NULL CHECK (unit_cost >= 0)
);

-- ---------- 5. Inventory ------------------------------------------------------
CREATE TABLE batches (                                  -- US-05 batch & expiry
    id           UUID PRIMARY KEY,
    product_id   UUID NOT NULL REFERENCES products(id),
    batch_number TEXT NOT NULL,
    expiry_date  DATE NOT NULL,
    qty_on_hand  INTEGER NOT NULL DEFAULT 0,            -- may go negative ONLY via offline sync (ADR-006)
    unit_cost    NUMERIC(12,4) NOT NULL DEFAULT 0,      -- weighted average, per base unit
    status       batch_status NOT NULL DEFAULT 'ACTIVE',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (product_id, batch_number, expiry_date)
);
CREATE INDEX ix_batches_fefo ON batches (product_id, expiry_date) WHERE status = 'ACTIVE';

ALTER TABLE goods_receipt_items
    ADD CONSTRAINT fk_gri_batch FOREIGN KEY (batch_id) REFERENCES batches(id);

CREATE TABLE stock_adjustments (                        -- US-12
    id            UUID PRIMARY KEY,
    product_id    UUID NOT NULL REFERENCES products(id),
    batch_id      UUID NOT NULL REFERENCES batches(id),
    qty_delta     INTEGER NOT NULL CHECK (qty_delta <> 0),
    reason        adjustment_reason NOT NULL,
    note          TEXT,
    status        adjustment_status NOT NULL DEFAULT 'PENDING_APPROVAL',
    requested_by  UUID NOT NULL REFERENCES users(id),
    approved_by   UUID REFERENCES users(id),
    decided_at    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (status <> 'APPROVED' OR approved_by IS NOT NULL)
);

CREATE TABLE stock_movements (                          -- append-only ledger; NEVER updated
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id   UUID NOT NULL REFERENCES products(id),
    batch_id     UUID NOT NULL REFERENCES batches(id),
    qty_delta    INTEGER NOT NULL CHECK (qty_delta <> 0),  -- + in, − out (base units)
    type         movement_type NOT NULL,
    ref_type     TEXT NOT NULL,                         -- 'sale','goods_receipt','stock_adjustment','sale_return'
    ref_id       UUID NOT NULL,
    unit_cost    NUMERIC(12,4) NOT NULL DEFAULT 0,      -- cost snapshot at movement time
    performed_by UUID NOT NULL REFERENCES users(id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_mov_product ON stock_movements (product_id, created_at DESC);
CREATE INDEX ix_mov_ref     ON stock_movements (ref_type, ref_id);

-- ---------- 6. Customers & sales ----------------------------------------------
CREATE TABLE customers (
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
    client_sale_id UUID NOT NULL UNIQUE,               -- idempotent offline sync (ADR-006)
    receipt_number TEXT NOT NULL UNIQUE,               -- 'RCP-2026-000123', server-assigned
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
CREATE INDEX ix_sales_sold_at ON sales (sold_at DESC);
CREATE INDEX ix_sales_cashier ON sales (cashier_id, sold_at DESC);

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
    sale_id      UUID NOT NULL REFERENCES sales(id),
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
    action     TEXT NOT NULL,                           -- 'sale.void','product.price_change','auth.lockout'…
    entity     TEXT NOT NULL,
    entity_id  TEXT NOT NULL,
    before     JSONB,
    after      JSONB,
    ip_address INET,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_audit_entity ON audit_logs (entity, entity_id, created_at DESC);

CREATE TABLE settings (
    key        TEXT PRIMARY KEY,                        -- 'vat_rate','expiry_warn_days','adjust_approval_threshold','receipt_header'
    value      JSONB NOT NULL,
    updated_by UUID REFERENCES users(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
    id         UUID PRIMARY KEY,
    type       TEXT NOT NULL,                           -- 'LOW_STOCK','EXPIRY_90','EXPIRED','NEG_STOCK_EXCEPTION'
    payload    JSONB NOT NULL,
    seen_at    TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 8. Reporting views ---------------------------------------------------
CREATE VIEW v_stock_on_hand AS
SELECT p.id AS product_id, p.name, p.base_unit,
       COALESCE(SUM(b.qty_on_hand) FILTER (WHERE b.status = 'ACTIVE'), 0) AS qty_base,
       COALESCE(SUM(b.qty_on_hand * b.unit_cost) FILTER (WHERE b.status = 'ACTIVE'), 0)::numeric(14,2) AS value_at_cost,
       p.reorder_level
FROM products p LEFT JOIN batches b ON b.product_id = p.id
WHERE p.deleted_at IS NULL
GROUP BY p.id;

CREATE VIEW v_low_stock AS
SELECT * FROM v_stock_on_hand WHERE qty_base <= reorder_level;

CREATE VIEW v_expiring_batches AS
SELECT b.*, p.name AS product_name,
       (b.expiry_date - CURRENT_DATE) AS days_to_expiry,
       (b.qty_on_hand * b.unit_cost)::numeric(14,2) AS value_at_risk
FROM batches b JOIN products p ON p.id = b.product_id
WHERE b.status = 'ACTIVE' AND b.qty_on_hand > 0
  AND b.expiry_date <= CURRENT_DATE + INTERVAL '90 days';

CREATE VIEW v_daily_sales AS
SELECT sold_at::date AS day, COUNT(*) AS receipts,
       SUM(total) AS gross, SUM(vat_total) AS vat, SUM(discount_total) AS discounts
FROM sales WHERE status = 'COMPLETED'
GROUP BY sold_at::date;

CREATE VIEW v_shrinkage AS
SELECT sa.reason, COUNT(*) AS adjustments, SUM(sa.qty_delta) AS qty_base,
       SUM(sa.qty_delta * b.unit_cost)::numeric(14,2) AS value
FROM stock_adjustments sa JOIN batches b ON b.id = sa.batch_id
WHERE sa.status = 'APPROVED' AND sa.qty_delta < 0
GROUP BY sa.reason;
