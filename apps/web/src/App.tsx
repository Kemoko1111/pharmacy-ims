import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { Layout } from './components/Layout';
import Login from './pages/Login';
import Pos from './pages/Pos';
import Receipt from './pages/Receipt';
import Dashboard from './pages/Dashboard';
import Products from './pages/Products';
import SalesHistory from './pages/SalesHistory';

function Protected({ children, roles }: { children: React.ReactNode; roles?: string[] }) {
  const { user, ready } = useAuth();
  if (!ready) {
    return <div className="grid h-full place-items-center text-ink-muted">Loading…</div>;
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
        <Route path="sales" element={<SalesHistory />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
