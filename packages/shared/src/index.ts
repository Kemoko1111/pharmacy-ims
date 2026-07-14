// Shared contract between @pharmatrack/api and @pharmatrack/web.
// Mirrors docs/week3/api-schema.md — change the doc first, then this file.

export type UserRole =
  | 'ADMIN'
  | 'MANAGER'
  | 'PHARMACIST'
  | 'INVENTORY_OFFICER'
  | 'CASHIER';

export const USER_ROLES: UserRole[] = [
  'ADMIN',
  'MANAGER',
  'PHARMACIST',
  'INVENTORY_OFFICER',
  'CASHIER',
];

export type DosageForm =
  | 'TABLET'
  | 'CAPSULE'
  | 'SYRUP'
  | 'SUSPENSION'
  | 'INJECTION'
  | 'CREAM'
  | 'OINTMENT'
  | 'DROPS'
  | 'INHALER'
  | 'SUPPOSITORY'
  | 'CONSUMABLE'
  | 'OTHER';

export const DOSAGE_FORMS: DosageForm[] = [
  'TABLET',
  'CAPSULE',
  'SYRUP',
  'SUSPENSION',
  'INJECTION',
  'CREAM',
  'OINTMENT',
  'DROPS',
  'INHALER',
  'SUPPOSITORY',
  'CONSUMABLE',
  'OTHER',
];

export type PaymentMethod = 'CASH' | 'MOMO' | 'CARD';
export type SaleStatus = 'COMPLETED' | 'VOIDED';
export type BatchStatus = 'ACTIVE' | 'EXPIRED' | 'QUARANTINED' | 'DEPLETED';

// ── Auth ─────────────────────────────────────────────────────────────────────

export interface AuthUser {
  id: string;
  username: string;
  fullName: string;
  role: UserRole;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

// ── Catalog ──────────────────────────────────────────────────────────────────

export interface Category {
  id: string;
  name: string;
}

export interface ProductUnit {
  id: string;
  unitName: string;
  factorToBase: number;
  sellingPrice: string; // NUMERIC(12,2) serialized as string
  isActive: boolean;
}

export interface ProductBarcode {
  id: string;
  barcode: string;
  productUnitId: string | null;
}

export interface ProductSummary {
  id: string;
  name: string;
  genericName: string | null;
  strength: string | null;
  form: DosageForm;
  categoryId: string;
  categoryName?: string;
  baseUnit: string;
  sellingPriceBase: string;
  reorderLevel: number;
  vatApplies: boolean;
  prescriptionOnly: boolean;
  qtyOnHand: number; // base units, ACTIVE batches
  nearestExpiry: string | null; // ISO date
}

export interface Product extends ProductSummary {
  notes: string | null;
  legacyItemNo: string | null;
  units: ProductUnit[];
  barcodes: ProductBarcode[];
  batches?: BatchSummary[];
}

export interface BatchSummary {
  id: string;
  batchNumber: string;
  expiryDate: string;
  qtyOnHand: number;
  status: BatchStatus;
}

// ── Sales ────────────────────────────────────────────────────────────────────

export interface SaleItemCreate {
  productId: string;
  productUnitId?: string | null; // null ⇒ base unit
  quantity: number; // in the sold unit
  unitPrice: string | number;
  discount?: string | number;
}

export interface PaymentCreate {
  method: PaymentMethod;
  amount: string | number;
  tendered?: string | number;
  momoRef?: string;
}

export interface SaleCreate {
  clientSaleId: string; // UUIDv7 generated at the till (idempotency key)
  soldAt: string; // ISO timestamp, client clock (offline-true)
  customerId?: string | null;
  items: SaleItemCreate[];
  payments: PaymentCreate[];
}

export interface SaleLine {
  id: string;
  productId: string;
  productName: string;
  productUnitId: string | null;
  unitName: string;
  quantity: number;
  qtyBase: number;
  unitPrice: string;
  discount: string;
  lineTotal: string;
}

export interface Sale {
  id: string;
  clientSaleId: string;
  receiptNumber: string;
  cashierId: string;
  cashierName?: string;
  status: SaleStatus;
  subtotal: string;
  discountTotal: string;
  vatTotal: string;
  total: string;
  soldAt: string;
  syncedOffline: boolean;
  items: SaleLine[];
  payments: {
    method: PaymentMethod;
    amount: string;
    tendered: string | null;
    changeDue: string | null;
  }[];
}

export interface SyncResult {
  clientSaleId: string;
  status: 'created' | 'duplicate' | 'error';
  receiptNumber?: string;
  error?: string;
}

// ── Reports ──────────────────────────────────────────────────────────────────

export interface DailyReport {
  date: string;
  gross: string;
  receipts: number;
  vat: string;
  discounts: string;
  byMethod: { method: PaymentMethod; amount: string }[];
  byCashier: { cashierId: string; cashierName: string; amount: string; receipts: number }[];
}

// ── Envelopes ────────────────────────────────────────────────────────────────

export interface ListMeta {
  page: number;
  pageSize: number;
  total: number;
}

export interface ListResponse<T> {
  data: T[];
  meta: ListMeta;
}

export interface ApiError {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

// ── POS keyboard map (wireframes §Keyboard shortcuts) ────────────────────────

export const POS_KEYS = {
  search: '/',
  newSale: 'F2',
  payment: 'F4',
  quantity: 'F6',
  discount: 'F8',
  removeLine: 'Delete',
  holdRecall: 'F9',
} as const;
