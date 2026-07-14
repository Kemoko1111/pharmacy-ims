-- Server-assigned document numbers (receipt/PO/GRN) — implementation detail on
-- top of the Week 3 DDL. Format: RCP-2026-000123 built app-side from nextval().
CREATE SEQUENCE IF NOT EXISTS receipt_number_seq START 1;
CREATE SEQUENCE IF NOT EXISTS po_number_seq START 1;
CREATE SEQUENCE IF NOT EXISTS grn_number_seq START 1;
