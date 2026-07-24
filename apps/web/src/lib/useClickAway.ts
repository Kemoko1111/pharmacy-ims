import { useEffect, type RefObject } from 'react';

/**
 * Close a popover/menu when the user clicks outside `ref` or presses Escape.
 * No-op while `active` is false so listeners only exist while something is open.
 */
export function useClickAway(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onAway: () => void,
) {
  useEffect(() => {
    if (!active) return;
    const onPointer = (e: PointerEvent) => {
      const el = ref.current;
      if (el && !el.contains(e.target as Node)) onAway();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onAway();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [ref, active, onAway]);
}
