'use client';
import { useRef, useState } from 'react';
import type { Clip } from '../lib/scenes';
import { ClipPlayer } from './exchange';

// Two recordings in one media column: one plays at a time.
export function ClipTabs({
  id,
  tabs,
  label,
}: {
  id: string;
  tabs: { key: string; label: string; clip: Clip }[];
  label: string;
}) {
  const [cur, setCur] = useState(0);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const t = tabs[cur];
  function onKey(e: React.KeyboardEvent) {
    const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const next = (cur + dir + tabs.length) % tabs.length;
    setCur(next);
    refs.current[next]?.focus();
  }
  return (
    <div className="clip-tabs">
      <div className="seg" role="tablist" aria-label={label}>
        {tabs.map((x, i) => (
          <button
            key={x.key}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${id}-tab-${x.key}`}
            aria-selected={i === cur}
            aria-controls={`${id}-panel`}
            tabIndex={i === cur ? 0 : -1}
            onClick={() => setCur(i)}
            onKeyDown={onKey}
          >
            {x.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-tab-${t.key}`}
      >
        <ClipPlayer key={t.key} clip={t.clip} label={t.label} />
      </div>
    </div>
  );
}
