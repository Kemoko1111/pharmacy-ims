import { FormEvent, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { forgetOfflineCredentials, hasOfflineCredential, OFFLINE_TTL_MS } from '../lib/offlineCreds';

const OFFLINE_TTL_DAYS = Math.round(OFFLINE_TTL_MS / 86_400_000);

interface SettingsShape {
  vat_rate?: number;
  expiry_warn_days?: number;
  adjust_approval_threshold?: number;
  alert_phone?: string;
  receipt_header?: { line1?: string; line2?: string; line3?: string };
}

/** Screen 14 — tax, thresholds, receipt header, SMS alert phone (Admin). */
export default function Settings() {
  const { data } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api<SettingsShape>('/settings'),
  });

  if (!data) {
    return <div className="grid h-full place-items-center text-ink-muted">Loading settings…</div>;
  }
  return <SettingsForm initial={data} />;
}

function SettingsForm({ initial }: { initial: SettingsShape }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(() => ({
    vat_rate: initial.vat_rate !== undefined ? String(initial.vat_rate) : '',
    expiry_warn_days: initial.expiry_warn_days !== undefined ? String(initial.expiry_warn_days) : '',
    adjust_approval_threshold:
      initial.adjust_approval_threshold !== undefined ? String(initial.adjust_approval_threshold) : '',
    alert_phone: initial.alert_phone ?? '',
    line1: initial.receipt_header?.line1 ?? '',
    line2: initial.receipt_header?.line2 ?? '',
    line3: initial.receipt_header?.line3 ?? '',
  }));
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      api('/settings', {
        method: 'PATCH',
        queue: { label: 'Settings changed' },
        body: {
          vat_rate: Number(form.vat_rate),
          expiry_warn_days: Number(form.expiry_warn_days),
          adjust_approval_threshold: Number(form.adjust_approval_threshold),
          alert_phone: form.alert_phone,
          receipt_header: { line1: form.line1, line2: form.line2, line3: form.line3 },
        },
      }),
    onSuccess: () => {
      setSaved(true);
      setError(null);
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      setTimeout(() => setSaved(false), 2500);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Save failed'),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const input = 'w-full rounded-lg border border-edge bg-bg px-3 py-2 outline-none focus:border-primary';
  const label = 'mb-1 mt-3 block text-sm font-medium';

  return (
    <div className="mx-auto max-w-lg p-4">
      <h1 className="text-xl font-bold">Settings</h1>
      <p className="mt-1 text-sm text-ink-muted">Every change here is written to the audit log.</p>

      <form onSubmit={submit} className="mt-4 rounded-xl border border-edge bg-surface p-5">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={label} htmlFor="vat-rate">VAT rate (0–1)</label>
            <input id="vat-rate" type="number" step="0.01" min="0" max="1" value={form.vat_rate} onChange={set('vat_rate')} className={input} />
          </div>
          <div>
            <label className={label} htmlFor="expiry-warn-days">Expiry warning (days)</label>
            <input id="expiry-warn-days" type="number" min="1" max="365" value={form.expiry_warn_days} onChange={set('expiry_warn_days')} className={input} />
          </div>
        </div>

        <label className={label} htmlFor="adjust-approval-threshold">Adjustment auto-approve threshold (GHS at cost)</label>
        <input id="adjust-approval-threshold" type="number" step="0.01" min="0" value={form.adjust_approval_threshold} onChange={set('adjust_approval_threshold')} className={input} />
        <p className="mt-1 text-xs text-ink-muted">Adjustments above this value wait for Manager approval (BR-05).</p>

        <label className={label} htmlFor="alert-phone">SMS alert phone (Africa's Talking)</label>
        <input id="alert-phone" value={form.alert_phone} onChange={set('alert_phone')} placeholder="+233 20 000 0000" className={input} />

        <div className="mt-4 rounded-lg border border-edge p-3">
          <div className="text-sm font-semibold text-ink-muted">Receipt header (80 mm print)</div>
          <label className={label} htmlFor="receipt-line1">Line 1</label>
          <input id="receipt-line1" value={form.line1} onChange={set('line1')} className={input} />
          <label className={label} htmlFor="receipt-line2">Line 2</label>
          <input id="receipt-line2" value={form.line2} onChange={set('line2')} className={input} />
          <label className={label} htmlFor="receipt-line3">Line 3</label>
          <input id="receipt-line3" value={form.line3} onChange={set('line3')} className={input} />
        </div>

        {error && <p className="mt-3 rounded bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
        {saved && <p className="mt-3 rounded bg-ok/10 px-3 py-2 text-sm text-ok">Saved ✓</p>}

        <button disabled={save.isPending} className="mt-4 w-full rounded-lg bg-primary py-2.5 font-semibold text-white disabled:opacity-50 dark:text-slate-900">
          {save.isPending ? 'Saving…' : 'Save settings'}
        </button>
      </form>

      <OfflineSignInPanel />
    </div>
  );
}

/**
 * The only way to revoke a device's cached sign-in on purpose. Signing out
 * deliberately does not do this — a cashier who signs out at close of business
 * still has to be able to open the till during tomorrow's outage.
 */
function OfflineSignInPanel() {
  const [saved, setSaved] = useState<boolean | null>(null);
  const [cleared, setCleared] = useState(false);

  useEffect(() => {
    hasOfflineCredential().then(setSaved).catch(() => setSaved(false));
  }, []);

  const forget = async () => {
    await forgetOfflineCredentials();
    setSaved(false);
    setCleared(true);
  };

  return (
    <section className="mt-6 max-w-lg rounded-xl border border-edge bg-surface p-6">
      <div className="text-sm font-semibold text-ink-muted">Offline sign-in on this till</div>
      <p className="mt-2 text-sm">
        {saved
          ? `A sign-in is saved on this device, so the till can be opened during an outage. It expires ${OFFLINE_TTL_DAYS} days after the last online sign-in.`
          : 'No sign-in is saved on this device. Signing in while online will save one.'}
      </p>
      {cleared && <p className="mt-2 text-sm text-ok">Cleared ✓ — this till now needs the server to sign in.</p>}
      <button
        onClick={forget}
        disabled={!saved}
        className="mt-3 rounded-lg border border-edge px-3 py-2 text-sm font-semibold hover:bg-danger/10 hover:text-danger disabled:opacity-40"
      >
        Forget offline sign-in
      </button>
    </section>
  );
}
