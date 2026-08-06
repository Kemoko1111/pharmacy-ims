import { useEffect, useRef } from 'react';

/**
 * USB scanner as keyboard wedge (ADR-008): detect a fast keystroke burst
 * terminated by Enter and hand the code to the POS regardless of focus.
 * Humans type < 30 cps; wedges emit > 50 cps, so a 40 ms inter-key gap and
 * minimum length of 5 separate scans from typing.
 *
 * "Regardless of focus" has one exception, and it cost a sale to find: while a
 * modal is open the wedge must stand down. It listens on window in the capture
 * phase, so it sees Enter before the dialog does — and if the cashier had just
 * typed five or more characters quickly (an amount tendered on a keypad, a
 * customer name), the wedge read that as a barcode, consumed the Enter and
 * called `stopPropagation()`. The payment dialog never saw the key, the sale
 * did not complete, and a random product was added to the cart behind it.
 */

/** Nested modals are possible (payment over hold/recall), so count, don't flag. */
let suspendDepth = 0;

export function suspendWedge(): () => void {
  suspendDepth++;
  let released = false;
  return () => {
    if (released) return; // a double-release must not un-suspend someone else
    released = true;
    suspendDepth = Math.max(0, suspendDepth - 1);
  };
}

export function isWedgeSuspended(): boolean {
  return suspendDepth > 0;
}

/**
 * Stand the scanner down for as long as the calling component is mounted.
 * Every modal that takes keyboard input should use this.
 */
export function useWedgeSuspended(): void {
  useEffect(() => suspendWedge(), []);
}

export function useBarcodeWedge(onScan: (code: string) => void) {
  const buffer = useRef('');
  const lastKey = useRef(0);
  // `onScan` closes over the cart, so its identity changes on every add. Read it
  // through a ref and the listener can register once — otherwise a re-render
  // mid-burst tears down the listener and the half-read barcode with it.
  const onScanRef = useRef(onScan);
  useEffect(() => {
    onScanRef.current = onScan;
  });

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (isWedgeSuspended()) return;
      // Shortcuts and IME composition are not scanner output.
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;

      const now = performance.now();
      if (now - lastKey.current > 40) buffer.current = '';
      lastKey.current = now;

      if (e.key === 'Enter') {
        const code = buffer.current;
        buffer.current = '';
        if (code.length >= 5) {
          onScanRef.current(code);
          e.preventDefault();
          // Nothing else on window should also act on this Enter — plain
          // stopPropagation does not stop same-target listeners.
          e.stopImmediatePropagation();
        }
        return;
      }
      if (e.key.length === 1) buffer.current += e.key;
    };

    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);
}
