import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useOnline } from '../lib/useOnline';
import { refreshSnapshot } from '../lib/offline';
import { useClickAway } from '../lib/useClickAway';
import { NotificationsBell } from './NotificationsBell';
import { BranchSwitcher } from './BranchSwitcher';

const NAV: { to: string; label: string; roles?: string[] }[] = [
  { to: '/pos', label: 'POS', roles: ['CASHIER', 'PHARMACIST', 'MANAGER'] },
  { to: '/dashboard', label: 'Dashboard', roles: ['MANAGER', 'PHARMACIST'] },
  { to: '/products', label: 'Products' },
  { to: '/batches', label: 'Batches', roles: ['PHARMACIST', 'MANAGER', 'INVENTORY_OFFICER'] },
  { to: '/purchasing', label: 'Purchasing', roles: ['INVENTORY_OFFICER', 'MANAGER'] },
  { to: '/adjustments', label: 'Adjustments', roles: ['PHARMACIST', 'MANAGER', 'INVENTORY_OFFICER'] },
  { to: '/sales', label: 'Sales' },
  { to: '/customers', label: 'Customers', roles: ['PHARMACIST', 'MANAGER'] },
  { to: '/reports', label: 'Reports', roles: ['MANAGER', 'PHARMACIST'] },
  { to: '/audit', label: 'Audit', roles: ['MANAGER'] },
  { to: '/users', label: 'Users', roles: [] }, // ADMIN only (implicit pass)
  { to: '/settings', label: 'Settings', roles: [] },
];

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
  const { user, logout } = useAuth();
  const { online, unsynced } = useOnline();
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
    refreshSnapshot().catch(() => {});
    const id = setInterval(() => {
      if (navigator.onLine) refreshSnapshot().catch(() => {});
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
            <span className="rounded-full bg-warn/20 px-2 py-0.5 text-sm font-semibold text-warn">
              ⇅ {unsynced} unsynced
            </span>
          )}

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
      </header>

      <main className="min-h-0 flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
