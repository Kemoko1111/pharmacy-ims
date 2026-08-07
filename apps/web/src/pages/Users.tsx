import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Branch, USER_ROLES, UserRole } from '@pharmatrack/shared';
import { api, ApiError } from '../lib/api';
import { shortDate } from '../lib/format';

interface UserRow {
  id: string;
  username: string;
  fullName: string;
  phone: string | null;
  role: UserRole;
  isActive: boolean;
  createdAt: string;
  /** Branches this account may work in (ADR-010). */
  branches: Branch[];
  defaultBranchId: string | null;
}

/** Screen 13 — Users & roles (Admin). */
export default function Users() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<UserRow | 'new' | null>(null);

  const { data } = useQuery({
    queryKey: ['users'],
    queryFn: () => api<{ data: UserRow[] }>('/users?pageSize=100'),
  });

  const toggleActive = useMutation({
    mutationFn: (u: UserRow) =>
      api(`/users/${u.id}`, {
        method: 'PATCH',
        body: { isActive: !u.isActive },
        // Queued like any other write, per the client's decision that the whole
        // system works offline. ADR-013 records the risk: an access change made
        // on a disconnected till only takes effect when it syncs.
        queue: { label: `User ${u.isActive ? 'disabled' : 'enabled'}: ${u.username}` },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['users'] }),
  });

  return (
    <div className="mx-auto max-w-4xl p-4">
      <div className="mb-4 flex items-center gap-3">
        <h1 className="text-xl font-bold">Users & roles</h1>
        <button
          onClick={() => setEditing('new')}
          className="ml-auto rounded-lg bg-primary px-4 py-2 font-semibold text-white dark:text-slate-900"
        >
          + New user
        </button>
      </div>

      <div className="overflow-x-auto rounded-xl border border-edge bg-surface">
        <table className="w-full text-[15px]">
          <thead>
            <tr className="border-b border-edge text-left text-sm text-ink-muted">
              <th className="px-3 py-2">User</th>
              <th className="px-3 py-2">Role</th>
              <th className="px-3 py-2">Branches</th>
              <th className="px-3 py-2">Phone</th>
              <th className="px-3 py-2">Since</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {(data?.data ?? []).map((u) => (
              <tr key={u.id} className={`border-b border-edge last:border-0 hover:bg-bg ${u.isActive ? '' : 'opacity-50'}`}>
                <td className="px-3 py-2">
                  <span className="font-medium">{u.fullName}</span>
                  <span className="ml-2 font-mono text-sm text-ink-muted">@{u.username}</span>
                </td>
                <td className="px-3 py-2">
                  <span className="rounded bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">{u.role}</span>
                </td>
                <td className="px-3 py-2">
                  {u.branches.length === 0 ? (
                    <span className="text-sm font-semibold text-danger" title="This account cannot sign in">
                      none — cannot sign in
                    </span>
                  ) : (
                    <span className="flex flex-wrap gap-1">
                      {u.branches.map((b) => (
                        <span
                          key={b.id}
                          title={b.name}
                          className={`rounded px-1.5 py-0.5 font-mono text-xs ${
                            b.id === u.defaultBranchId
                              ? 'bg-primary/15 font-bold text-primary'
                              : 'bg-ink/10 text-ink-muted'
                          }`}
                        >
                          {b.code}
                        </span>
                      ))}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-ink-muted">{u.phone ?? '—'}</td>
                <td className="px-3 py-2 text-sm text-ink-muted">{shortDate(u.createdAt)}</td>
                <td className="px-3 py-2">
                  <span className={`text-sm font-semibold ${u.isActive ? 'text-ok' : 'text-danger'}`}>
                    {u.isActive ? 'active' : 'disabled'}
                  </span>
                </td>
                <td className="px-3 py-2 text-right">
                  <button onClick={() => setEditing(u)} className="text-primary hover:underline">Edit</button>
                  <button
                    onClick={() => toggleActive.mutate(u)}
                    className={`ml-3 hover:underline ${u.isActive ? 'text-danger' : 'text-ok'}`}
                  >
                    {u.isActive ? 'Disable' : 'Enable'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <UserForm
          user={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            queryClient.invalidateQueries({ queryKey: ['users'] });
          }}
        />
      )}
    </div>
  );
}

function UserForm({ user, onClose, onDone }: { user: UserRow | null; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({
    username: user?.username ?? '',
    fullName: user?.fullName ?? '',
    phone: user?.phone ?? '',
    role: user?.role ?? ('CASHIER' as UserRole),
    password: '',
  });
  // null ⇒ the operator has not touched the picker yet, which lets a
  // single-branch business get a working account without ticking anything.
  // Derived during render rather than synced by an effect.
  const [picked, setPicked] = useState<string[] | null>(user ? user.branches.map((b) => b.id) : null);
  const [pickedDefault, setPickedDefault] = useState<string | null>(user?.defaultBranchId ?? null);
  const [error, setError] = useState<string | null>(null);

  const { data: branches = [] } = useQuery({
    queryKey: ['branches'],
    queryFn: () => api<Branch[]>('/branches'),
  });

  const branchIds = picked ?? (branches.length === 1 ? [branches[0].id] : []);
  const defaultBranchId =
    pickedDefault && branchIds.includes(pickedDefault) ? pickedDefault : (branchIds[0] ?? null);

  const toggleBranch = (id: string) => {
    const next = branchIds.includes(id) ? branchIds.filter((b) => b !== id) : [...branchIds, id];
    setPicked(next);
    if (!next.includes(pickedDefault ?? '')) setPickedDefault(next[0] ?? null);
  };

  const save = useMutation({
    mutationFn: async () => {
      if (user) {
        await api(`/users/${user.id}`, {
          method: 'PATCH',
          body: {
            fullName: form.fullName,
            phone: form.phone || undefined,
            role: form.role,
            branchIds,
            defaultBranchId: defaultBranchId ?? undefined,
          },
        });
        // A password is optional on edit; when provided, apply it (also clears
        // any lockout and signs the user out everywhere).
        if (form.password) {
          await api(`/users/${user.id}/reset-password`, {
            method: 'POST',
            body: { newPassword: form.password },
          });
        }
        return;
      }
      return api('/users', {
        method: 'POST',
        body: {
          username: form.username,
          fullName: form.fullName,
          phone: form.phone || undefined,
          role: form.role,
          password: form.password,
          branchIds,
          defaultBranchId: defaultBranchId ?? undefined,
        },
      });
    },
    onSuccess: onDone,
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Save failed'),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    // Caught here as well as server-side: an account with no branch cannot sign
    // in at all, and that is a confusing failure to debug after the fact.
    if (branchIds.length === 0) {
      setError('Assign at least one branch — an account with no branch cannot sign in.');
      return;
    }
    save.mutate();
  };

  const input = 'w-full rounded-lg border border-edge bg-bg px-3 py-2 outline-none focus:border-primary';
  const label = 'mb-1 mt-3 block text-sm font-medium';

  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-auto bg-black/50 p-4" onClick={onClose}>
      <form onSubmit={submit} onClick={(e) => e.stopPropagation()} className="w-full max-w-sm rounded-xl border border-edge bg-surface p-6">
        <h2 className="text-lg font-bold">{user ? `Edit @${user.username}` : 'New user'}</h2>

        {!user && (
          <>
            <label className={label} htmlFor="user-username">Username *</label>
            <input id="user-username" required value={form.username} onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))} className={input} />
          </>
        )}

        <label className={label} htmlFor="user-fullname">Full name *</label>
        <input id="user-fullname" required value={form.fullName} onChange={(e) => setForm((f) => ({ ...f, fullName: e.target.value }))} className={input} />

        <label className={label} htmlFor="user-phone">Phone</label>
        <input id="user-phone" value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} className={input} />

        <label className={label} htmlFor="user-role">Role *</label>
        <select id="user-role" value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value as UserRole }))} className={input}>
          {USER_ROLES.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>

        <fieldset className="mt-3">
          <legend className="mb-1 block text-sm font-medium">Branches *</legend>
          <p className="mb-2 text-xs text-ink-muted">
            Where this user may work. The starred branch opens at sign-in.
            {user && ' Changing this signs them out everywhere.'}
          </p>
          <div className="rounded-lg border border-edge">
            {branches.length === 0 && (
              <p className="px-3 py-2 text-sm text-ink-muted">No branches configured yet.</p>
            )}
            {branches.map((b) => {
              const checked = branchIds.includes(b.id);
              return (
                <div key={b.id} className="flex items-center gap-2 border-b border-edge px-3 py-2 last:border-0">
                  <input
                    type="checkbox"
                    id={`branch-${b.id}`}
                    checked={checked}
                    onChange={() => toggleBranch(b.id)}
                    className="h-4 w-4"
                  />
                  <label htmlFor={`branch-${b.id}`} className="flex-1 cursor-pointer text-[15px]">
                    <span className="font-mono text-xs text-ink-muted">{b.code}</span> {b.name}
                  </label>
                  {checked && (
                    <button
                      type="button"
                      onClick={() => setPickedDefault(b.id)}
                      title={b.id === defaultBranchId ? 'Opens at sign-in' : 'Make this the sign-in branch'}
                      aria-label={`Make ${b.name} the sign-in branch`}
                      className={b.id === defaultBranchId ? 'text-primary' : 'text-ink-muted hover:text-ink'}
                    >
                      {b.id === defaultBranchId ? '★' : '☆'}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </fieldset>

        <label className={label} htmlFor="user-password">{user ? 'New password' : 'Password *'}</label>
        <input
          id="user-password"
          required={!user}
          type="password"
          value={form.password}
          onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
          placeholder="8+ chars, upper, lower, digit"
          className={input}
        />
        {user && (
          <p className="mt-1 text-xs text-ink-muted">
            Leave blank to keep the current password. Setting a new one signs this user out everywhere.
          </p>
        )}

        {error && <p className="mt-3 rounded bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-edge px-4 py-2">Cancel</button>
          <button disabled={save.isPending} className="rounded-lg bg-primary px-4 py-2 font-semibold text-white disabled:opacity-50 dark:text-slate-900">
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}
