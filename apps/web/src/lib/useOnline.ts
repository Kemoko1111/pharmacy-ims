import { useEffect, useState } from 'react';
import { drainQueue, queuedCount } from './offline';

/** Online state + unsynced badge; auto-drains the queue on reconnect. */
export function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  const [unsynced, setUnsynced] = useState(0);

  useEffect(() => {
    const refreshCount = () => queuedCount().then(setUnsynced).catch(() => {});
    refreshCount();

    const up = async () => {
      setOnline(true);
      try {
        await drainQueue();
      } catch {
        /* still offline in practice; badge stays */
      }
      refreshCount();
    };
    const down = () => setOnline(false);
    const changed = () => refreshCount();

    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    window.addEventListener('pt-queue-changed', changed);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
      window.removeEventListener('pt-queue-changed', changed);
    };
  }, []);

  return { online, unsynced };
}
