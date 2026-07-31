import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { PwaUpdater } from './lib/pwaUpdate';
import { Layout } from './components/Layout';
import Login from './pages/Login';
import Pos from './pages/Pos';
import Receipt from './pages/Receipt';
import Dashboard from './pages/Dashboard';
import Products from './pages/Products';
import SalesHistory from './pages/SalesHistory';
import Batches from './pages/Batches';
import Purchasing from './pages/Purchasing';
import Adjustments from './pages/Adjustments';
import Transfers from './pages/Transfers';
import Branches from './pages/Branches';
import Reports from './pages/Reports';
import Customers from './pages/Customers';
import Users from './pages/Users';
import Settings from './pages/Settings';
import AuditLog from './pages/AuditLog';

function Protected({ children, roles }: { children: React.ReactNode; roles?: string[] }) {
  const { user, ready, waking } = useAuth();
  if (!ready) {
    return (
      <div className="grid h-full place-items-center px-6 text-center text-ink-muted">
        <div>
          <div className="animate-pulse text-lg">Loading…</div>
          {waking && (
            <p className="mt-2 max-w-xs text-sm">
              Waking the server up — this can take up to ~30&nbsp;seconds on first use after a quiet period.
            </p>
          )}
        </div>
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  if (roles && user.role !== 'ADMIN' && !roles.includes(user.role)) {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}

export default function App() {
  const { user } = useAuth();
  const home = user?.role === 'CASHIER' ? '/pos' : '/dashboard';

  return (
    <>
      <PwaUpdater />
      <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/receipt" element={<Protected><Receipt /></Protected>} />
      <Route
        path="/"
        element={
          <Protected>
            <Layout />
          </Protected>
        }
      >
        <Route index element={<Navigate to={home} replace />} />
        <Route path="pos" element={<Pos />} />
        <Route
          path="dashboard"
          element={
            <Protected roles={['MANAGER', 'PHARMACIST']}>
              <Dashboard />
            </Protected>
          }
        />
        <Route path="products" element={<Products />} />
        <Route
          path="batches"
          element={
            <Protected roles={['PHARMACIST', 'MANAGER', 'INVENTORY_OFFICER']}>
              <Batches />
            </Protected>
          }
        />
        <Route
          path="purchasing"
          element={
            <Protected roles={['INVENTORY_OFFICER', 'MANAGER']}>
              <Purchasing />
            </Protected>
          }
        />
        <Route
          path="adjustments"
          element={
            <Protected roles={['PHARMACIST', 'MANAGER', 'INVENTORY_OFFICER']}>
              <Adjustments />
            </Protected>
          }
        />
        <Route
          path="transfers"
          element={
            <Protected roles={['PHARMACIST', 'MANAGER', 'INVENTORY_OFFICER']}>
              <Transfers />
            </Protected>
          }
        />
        <Route path="sales" element={<SalesHistory />} />
        <Route
          path="customers"
          element={
            <Protected roles={['PHARMACIST', 'MANAGER']}>
              <Customers />
            </Protected>
          }
        />
        <Route
          path="reports"
          element={
            <Protected roles={['MANAGER', 'PHARMACIST']}>
              <Reports />
            </Protected>
          }
        />
        <Route
          path="audit"
          element={
            <Protected roles={['MANAGER']}>
              <AuditLog />
            </Protected>
          }
        />
        <Route
          path="branches"
          element={
            <Protected roles={[]}>
              <Branches />
            </Protected>
          }
        />
        <Route
          path="users"
          element={
            <Protected roles={[]}>
              <Users />
            </Protected>
          }
        />
        <Route
          path="settings"
          element={
            <Protected roles={[]}>
              <Settings />
            </Protected>
          }
        />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
