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
