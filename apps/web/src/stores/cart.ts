import { create } from 'zustand';
import { toP } from '../lib/format';

export interface CartLine {
  key: string; // productId + unitId
  productId: string;
  name: string;
  unitId: string | null;
  unitName: string;
  unitPrice: string; // per sold unit
  quantity: number;
  discount: string; // per line, GHS
  vatApplies: boolean;
  maxQtyBase: number; // stock guard (soft — server is the authority)
  factorToBase: number;
}

interface CartState {
  lines: CartLine[];
  selectedKey: string | null;
  add: (line: Omit<CartLine, 'key' | 'quantity' | 'discount'>) => void;
  setQty: (key: string, qty: number) => void;
  setDiscount: (key: string, discount: string) => void;
  remove: (key: string) => void;
  select: (key: string | null) => void;
  clear: () => void;
  setLines: (lines: CartLine[]) => void; // recall from a held sale (F9)
}

export const useCart = create<CartState>((set) => ({
  lines: [],
  selectedKey: null,
  add: (line) =>
    set((s) => {
      const key = `${line.productId}:${line.unitId ?? 'base'}`;
      const existing = s.lines.find((l) => l.key === key);
      if (existing) {
        return {
          lines: s.lines.map((l) => (l.key === key ? { ...l, quantity: l.quantity + 1 } : l)),
          selectedKey: key,
        };
      }
      return { lines: [...s.lines, { ...line, key, quantity: 1, discount: '0' }], selectedKey: key };
    }),
  setQty: (key, qty) =>
    set((s) => ({
      lines: qty <= 0 ? s.lines.filter((l) => l.key !== key) : s.lines.map((l) => (l.key === key ? { ...l, quantity: qty } : l)),
    })),
  setDiscount: (key, discount) =>
    set((s) => ({ lines: s.lines.map((l) => (l.key === key ? { ...l, discount } : l)) })),
  remove: (key) =>
    set((s) => ({
      lines: s.lines.filter((l) => l.key !== key),
      selectedKey: s.selectedKey === key ? null : s.selectedKey,
    })),
  select: (key) => set({ selectedKey: key }),
  clear: () => set({ lines: [], selectedKey: null }),
  setLines: (lines) => set({ lines, selectedKey: lines[0]?.key ?? null }),
}));

export function cartTotals(lines: CartLine[]) {
  const subtotalP = lines.reduce((s, l) => s + toP(l.unitPrice) * l.quantity, 0);
  const discountP = lines.reduce((s, l) => s + toP(l.discount || '0'), 0);
  return { subtotalP, discountP, totalP: subtotalP - discountP };
}
