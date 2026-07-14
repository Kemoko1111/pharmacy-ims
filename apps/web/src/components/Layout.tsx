import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useOnline } from '../lib/useOnline';
import { refreshSnapshot } from '../lib/offline';
import { NotificationsBell } from './NotificationsBell';

const NAV: { to: string; label: string; roles?: string[] }[] = [
  { to: '/pos', label: 'POS', roles: ['CASHIER', 'PHARMACIST', 'MANAGER'] },
  { to: '/dashboard', label: 'Dashboard', roles: ['MANAGER', 'PHARMACIST'] },
  { to: '/products', label: 'Products' },
  { to: '/batches', label: 'Batches', roles: ['PHARMACIST', 'MANAGER', 'INVENTORY_OFFICER'] },
  { to: '/purchasing', label: 'Purchasing', roles: ['INVENTORY_OFFICER', 'MANAGER'] },
  { to: '/adjustments', label: 'Adjustments', roles: ['PHARMACIST', 'MANAGER', 'INVENTORY_OFFICER'] },
  { to: '/sales', label: 'Sales' },
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

  // Catalogue snapshot for offline POS: on mount + every 15 min (ADR-006)
  useEffect(() => {
    refreshSnapshot().catch(() => {});
    const id = setInterval(() => {
      if (navigator.onLine) refreshSnapshot().catch(() => {});
    }, 15 * 60_000);
    return () => clearInterval(id);
  }, []);

  const visibleNav = NAV.filter(
    (n) => !n.roles || user?.role === 'ADMIN' || n.roles.includes(user?.role ?? ''),
  );

  return (
    <div className="flex h-full flex-col">
      {/* Status always visible (wireframes §Design principles #3) */}
      <header className="flex items-center gap-3 border-b border-edge bg-surface px-4 py-2">
        <span className="text-lg font-bold text-primary">PharmaTrack</span>

        <span
          className={`rounded-full px-2 py-0.5 text-sm font-medium ${
            online ? 'bg-ok/15 text-ok' : 'bg-warn/20 text-warn'
          }`}
        >
          {online ? '● ONLINE' : '● OFFLINE — sales are saved locally'}
        </span>

        {unsynced > 0 && (
          <span className="rounded-full bg-warn/20 px-2 py-0.5 text-sm font-semibold text-warn">
            ⇅ {unsynced} unsynced
          </span>
        )}

        <nav className="ml-6 flex gap-1">
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
          <span className="text-sm text-ink-muted">
            {user?.fullName} <span className="opacity-70">({user?.role})</span>
          </span>
          <button
            onClick={logout}
            className="rounded border border-edge px-3 py-1.5 text-sm hover:bg-danger/10 hover:text-danger"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
