import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { registerSW } from 'virtual:pwa-register';
import { useCart } from '../stores/cart';

/**
 * Deferred auto-update (ADR-002): a new build is downloaded silently, then
 * applied automatically only at a moment that can't interrupt anyone — when the
 * cart is empty (no sale in progress) or on the login screen between shifts.
 * Staff never see a prompt and never lose an in-progress sale.
 */
export function PwaUpdater() {
  const [needRefresh, setNeedRefresh] = useState(false);
  const updateRef = useRef<((reloadPage?: boolean) => Promise<void>) | null>(null);
  const location = useLocation();
  const cartCount = useCart((s) => s.lines.length);

  // Register the service worker once; flag when a new version is waiting.
  useEffect(() => {
    updateRef.current = registerSW({
      immediate: true,
      onNeedRefresh() {
        setNeedRefresh(true);
      },
    });
  }, []);

  // Apply the pending update as soon as it's safe: empty cart or login screen.
  useEffect(() => {
    if (!needRefresh) return;
    const onLogin = location.pathname.startsWith('/login');
    const saleInProgress = cartCount > 0;
    if (onLogin || !saleInProgress) {
      // updateSW(true) activates the waiting worker and reloads with the new build.
      updateRef.current?.(true);
    }
  }, [needRefresh, location.pathname, cartCount]);

  return null;
}
