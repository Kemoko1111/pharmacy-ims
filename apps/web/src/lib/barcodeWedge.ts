import { useEffect, useRef } from 'react';

/**
 * USB scanner as keyboard wedge (ADR-008): detect a fast keystroke burst
 * terminated by Enter and hand the code to the POS regardless of focus.
 * Humans type < 30 cps; wedges emit > 50 cps, so a 40 ms inter-key gap and
 * minimum length of 5 separate scans from typing.
 */
export function useBarcodeWedge(onScan: (code: string) => void) {
  const buffer = useRef('');
  const lastKey = useRef(0);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const now = performance.now();
      if (now - lastKey.current > 40) buffer.current = '';
      lastKey.current = now;

      if (e.key === 'Enter') {
        if (buffer.current.length >= 5) {
          onScan(buffer.current);
          e.preventDefault();
          e.stopPropagation();
        }
        buffer.current = '';
        return;
      }
      if (e.key.length === 1) buffer.current += e.key;
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [onScan]);
}
