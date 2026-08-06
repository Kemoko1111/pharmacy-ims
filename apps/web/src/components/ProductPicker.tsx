import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useClickAway } from '../lib/useClickAway';
import { useDebounced } from '../lib/useDebounced';

export interface PickedProduct {
  id: string;
  name: string;
  baseUnit: string;
}

interface ProductHit extends PickedProduct {
  genericName: string | null;
  strength: string | null;
  qtyOnHand: number;
}

/**
 * Type-to-find product field. Replaces the every-product `<select>` the client
 * called out: a shop carrying a few hundred lines cannot be scrolled at the
 * speed a counter runs at. Searches name and generic name server-side, so a
 * cashier who only knows "paracetamol" still finds "Panadol".
 */
export function ProductPicker({
  value,
  onPick,
  placeholder = 'Type to find a drug…',
  autoFocus,
}: {
  value: PickedProduct | null;
  onPick: (p: PickedProduct | null) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const debouncedQ = useDebounced(q, 200);

  useClickAway(boxRef, open, () => setOpen(false));

  const { data: hits = [] } = useQuery({
    queryKey: ['product-search', debouncedQ],
    queryFn: async () => {
      const res = await api<{ data: ProductHit[] }>(
        `/products?q=${encodeURIComponent(debouncedQ)}&pageSize=15`,
      );
      return res.data;
    },
    enabled: open && debouncedQ.trim().length >= 2,
  });

  const choose = (p: ProductHit) => {
    onPick({ id: p.id, name: p.name, baseUnit: p.baseUnit });
    setQ('');
    setOpen(false);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, hits.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      // Never let Enter reach the surrounding <form>: mid-search it would
      // submit a PO with no product on the line.
      e.preventDefault();
      if (hits[highlight]) choose(hits[highlight]);
    }
  };

  const input = 'w-full rounded-lg border border-edge bg-bg px-3 py-2 outline-none focus:border-primary';

  if (value) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-edge bg-bg px-3 py-2">
        <span className="truncate">{value.name}</span>
        <button
          type="button"
          onClick={() => onPick(null)}
          aria-label={`Clear ${value.name}`}
          className="ml-auto shrink-0 text-ink-muted hover:text-danger"
        >
          ✕
        </button>
      </div>
    );
  }

  return (
    <div ref={boxRef} className="relative">
      <input
        value={q}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={(e) => {
          setQ(e.target.value);
          setHighlight(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
        className={input}
      />
      {open && debouncedQ.trim().length >= 2 && (
        <ul className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-edge bg-surface shadow-lg">
          {hits.map((p, i) => (
            <li key={p.id}>
              <button
                type="button"
                onMouseEnter={() => setHighlight(i)}
                onClick={() => choose(p)}
                className={`block w-full px-3 py-2 text-left ${i === highlight ? 'bg-primary/10' : ''}`}
              >
                <span className="font-medium">{p.name}</span>
                {p.strength && <span className="ml-1 text-ink-muted">{p.strength}</span>}
                {p.genericName && <span className="ml-1 text-sm text-ink-muted">· {p.genericName}</span>}
                <span className="ml-2 text-sm text-ink-muted">
                  {p.qtyOnHand} {p.baseUnit} on hand
                </span>
              </button>
            </li>
          ))}
          {hits.length === 0 && (
            <li className="px-3 py-2 text-ink-muted">No drug matches “{debouncedQ}”.</li>
          )}
        </ul>
      )}
    </div>
  );
}
