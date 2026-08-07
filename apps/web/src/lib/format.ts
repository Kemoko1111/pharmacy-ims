/** Money display: numbers arrive as NUMERIC strings from the API. */
export function ghs(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const n = typeof value === 'string' ? Number(value) : value;
  return `GHS ${n.toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/**
 * "Last synced" in words a cashier can act on. An OFFLINE badge alone does not
 * say whether the till is ten minutes or two days behind the server. Shared by
 * the status bar and the Sync button so the two never disagree.
 */
export function syncedLabel(iso: string | null): string {
  if (!iso) return 'not synced yet';
  const then = new Date(iso);
  const sameDay = then.toDateString() === new Date().toDateString();
  return sameDay ? `synced ${timeOf(iso)}` : `synced ${shortDate(iso)} ${timeOf(iso)}`;
}

/** Integer pesewa math on the client mirrors the server (no floats on money). */
export const toP = (v: string | number) => Math.round(Number(v) * 100);
export const fromP = (p: number) => (p / 100).toFixed(2);
