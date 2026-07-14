import { Prisma } from '@prisma/client';

/**
 * Money math in integer pesewas (GHS × 100) — never floats (NFR-05).
 * DB stores NUMERIC(12,2); Prisma surfaces Decimal.
 */
export function toPesewas(value: Prisma.Decimal | string | number): number {
  const d = new Prisma.Decimal(value);
  const p = d.mul(100);
  if (!p.isInteger()) {
    throw new Error(`Money value ${d.toString()} has sub-pesewa precision`);
  }
  return p.toNumber();
}

export function fromPesewas(pesewas: number): Prisma.Decimal {
  return new Prisma.Decimal(pesewas).div(100);
}

/** VAT portion of a VAT-inclusive amount, in pesewas (round half up). */
export function vatPortion(inclusivePesewas: number, rate: number): number {
  return Math.round((inclusivePesewas * rate) / (1 + rate));
}
