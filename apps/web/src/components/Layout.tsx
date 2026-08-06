import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useOnline } from '../lib/useOnline';
import { refreshSnapshot } from '../lib/offline';
import { canUseServer } from '../lib/connectivity';
import { useClickAway } from '../lib/useClickAway';
import { shortDate, timeOf } from '../lib/format';
import { NotificationsBell } from './NotificationsBell';
import { BranchSwitcher } from './BranchSwitcher';

const NAV: { to: string; label: string; roles?: string[] }[] = [
  { to: '/pos', label: 'POS', roles: ['CASHIER', 'PHARMACIST', 'MANAGER'] },
  { to: '/dashboard', label: 'Dashboard', roles: ['MANAGER', 'PHARMACIST'] },
  { to: '/products', label: 'Products' },
  { to: '/batches', label: 'Batches', roles: ['PHARMACIST', 'MANAGER', 'INVENTORY_OFFICER'] },
  { to: '/purchasing', label: 'Purchasing', roles: ['INVENTORY_OFFICER', 'MANAGER'] },
  { to: '/adjustments', label: 'Adjustments', roles: ['PHARMACIST', 'MANAGER', 'INVENTORY_OFFICER'] },
  { to: '/transfers', label: 'Transfers', roles: ['PHARMACIST', 'MANAGER', 'INVENTORY_OFFICER'] },
  { to: '/sales', label: 'Sales' },
  { to: '/customers', label: 'Customers', roles: ['PHARMACIST', 'MANAGER'] },
  { to: '/reports', label: 'Reports', roles: ['MANAGER', 'PHARMACIST'] },
  { to: '/audit', label: 'Audit', roles: ['MANAGER'] },
  { to: '/branches', label: 'Branches', roles: [] }, // ADMIN only (implicit pass)
  { to: '/users', label: 'Users', roles: [] }, // ADMIN only (implicit pass)
  { to: '/settings', label: 'Settings', roles: [] },
];

/**
 * "Last synced" in words a cashier can act on. An OFFLINE badge alone does not
 * say whether the till is ten minutes or two days behind the server.
 */
function syncedLabel(iso: string | null): string {
  if (!iso) return 'not synced yet';
  const then = new Date(iso);
  const sameDay = then.toDateString() === new Date().toDateString();
  return sameDay ? `synced ${timeOf(iso)}` : `synced ${shortDate(iso)} ${timeOf(iso)}`;
}

function useTheme() {
  const [dark, setDark] = useState(document.documentElement.classList.contains('dark'));
  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    localStorage.setItem('pt-theme', next ? 'dark' : 'light');
  };
  return { dark, toggle };
}

export function Layout() {
  const { user, logout, offlineSession } = useAuth();
  const { online, unsynced, deferred, stuck, lastSyncedAt, syncing, retry } = useOnline();
  const { dark, toggle } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const headerRef = useRef<HTMLElement>(null);
  useClickAway(headerRef, menuOpen, useCallback(() => setMenuOpen(false), []));

  // Catalogue snapshot for offline POS: on mount + every 15 min (ADR-006)
  // Cached stock is per-branch (ADR-010), so re-snapshot whenever the active
  // branch changes as well as on the 15-minute cycle.
  const activeBranchId = user?.activeBranch?.id ?? null;
  useEffect(() => {
    if (!activeBranchId) return;
    if (canUseServer()) refreshSnapshot().catch(() => {});
    const id = setInterval(() => {
      // Reachability, not link state — a snapshot attempt over a dead link just
      // burns the request timeout (see connectivity.ts).
      if (canUseServer()) refreshSnapshot().catch(() => {});
    }, 15 * 60_000);
    return () => clearInterval(id);
  }, [activeBranchId]);

  const visibleNav = NAV.filter(
    (n) => !n.roles || user?.role === 'ADMIN' || n.roles.includes(user?.role ?? ''),
  );

  return (
    <div className="flex h-full flex-col">
      {/* Status always visible (wireframes §Design principles #3) */}
      <header ref={headerRef} className="border-b border-edge bg-surface">
        <div className="flex items-center gap-3 px-4 py-2">
          <Link to="/" className="text-lg font-bold text-primary hover:opacity-80">
            PharmaTrack
          </Link>

          <span
            className={`rounded-full px-2 py-0.5 text-sm font-medium ${
              online ? 'bg-ok/15 text-ok' : 'bg-warn/20 text-warn'
            }`}
          >
            {online ? '● ONLINE' : '● OFFLINE'}
            <span className="hidden sm:inline">
              {online ? '' : ' — sales are saved locally'}
            </span>
          </span>

          {unsynced > 0 && (
            <button
              onClick={retry}
              disabled={syncing}
              title={
                online
                  ? 'Send these sales to the server now'
                  : 'Saved on this till — they go up when the server is reachable'
              }
              className="rounded-full bg-warn/20 px-2 py-0.5 text-sm font-semibold text-warn disabled:opacity-60"
            >
              {syncing ? `⇅ syncing ${unsynced}…` : `⇅ ${unsynced} unsynced`}
            </button>
          )}

          {/* Queued at another shop: no amount of retrying helps until the till
              switches back, so it must not hide inside the unsynced count. */}
          {deferred > 0 && (
            <span
              className="rounded-full bg-ink-muted/15 px-2 py-0.5 text-sm font-semibold text-ink-muted"
              title="Taken at another branch — switch to that branch to sync them"
            >
              ⇄ {deferred} other branch
            </span>
          )}

          {stuck > 0 && (
            <span
              className="rounded-full bg-danger/15 px-2 py-0.5 text-sm font-semibold text-danger"
              title="The server refused these repeatedly — a manager needs to review them"
            >
              ⚠ {stuck} rejected
            </span>
          )}

          <span className="hidden text-sm text-ink-muted md:inline" title={lastSyncedAt ?? undefined}>
            {syncedLabel(lastSyncedAt)}
          </span>

          {/* Which shop this till is working in (ADR-010) */}
          <BranchSwitcher />

          {/* Desktop nav (inline) */}
          <nav className="ml-6 hidden gap-1 lg:flex">
            {visibleNav.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                className={({ isActive }) =>
                  `rounded px-3 py-1.5 text-sm font-medium ${
                    isActive ? 'bg-primary/15 text-primary' : 'text-ink-muted hover:text-ink'
                  }`
                }
              >
                {n.label}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            {['MANAGER', 'PHARMACIST', 'ADMIN'].includes(user?.role ?? '') && <NotificationsBell />}
            <button
              onClick={toggle}
              className="rounded px-2 py-1 text-sm text-ink-muted hover:text-ink"
              title="Toggle theme"
            >
              {dark ? '☀️' : '🌙'}
            </button>
            {/* User + sign out: inline on desktop, moved into drawer on mobile */}
            <span className="hidden text-sm text-ink-muted lg:inline">
              {user?.fullName} <span className="opacity-70">({user?.role})</span>
            </span>
            <button
              onClick={logout}
              className="hidden rounded border border-edge px-3 py-1.5 text-sm hover:bg-danger/10 hover:text-danger lg:inline-block"
            >
              Sign out
            </button>
            {/* Hamburger: mobile only */}
            <button
              onClick={() => setMenuOpen((o) => !o)}
              className="rounded border border-edge px-2.5 py-1 text-lg leading-none lg:hidden"
              aria-label="Toggle menu"
              aria-expanded={menuOpen}
            >
              {menuOpen ? '✕' : '☰'}
            </button>
          </div>
        </div>

        {/* Mobile nav drawer */}
        {menuOpen && (
          <nav className="flex flex-col gap-1 border-t border-edge px-3 pb-3 pt-2 lg:hidden">
            {visibleNav.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                onClick={() => setMenuOpen(false)}
                className={({ isActive }) =>
                  `rounded px-3 py-2.5 text-base font-medium ${
                    isActive ? 'bg-primary/15 text-primary' : 'text-ink-muted hover:text-ink'
                  }`
                }
              >
                {n.label}
              </NavLink>
            ))}
            <div className="mt-2 flex items-center justify-between border-t border-edge px-1 pt-3 text-sm text-ink-muted">
              <span>
                {user?.fullName} <span className="opacity-70">({user?.role})</span>
              </span>
              <button
                onClick={logout}
                className="rounded border border-edge px-3 py-1.5 hover:bg-danger/10 hover:text-danger"
              >
                Sign out
              </button>
            </div>
          </nav>
        )}

        {/* This session was opened against the password saved on the till, so
            it is not authenticated with the server. Selling works; anything
            that needs the server waits for a real sign-in. */}
        {offlineSession && (
          <div className="flex flex-wrap items-center gap-2 border-t border-warn/30 bg-warn/10 px-4 py-1.5 text-sm text-warn">
            <span className="font-semibold">Signed in offline.</span>
            <span>
              Sales are saved on this till{unsynced > 0 ? ` (${unsynced} waiting)` : ''}. Reports and
              stock figures may be out of date.
            </span>
            {online && (
              <button onClick={logout} className="ml-auto font-semibold underline">
                Server is back — sign in to sync
              </button>
            )}
          </div>
        )}
      </header>

      <main className="min-h-0 flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
