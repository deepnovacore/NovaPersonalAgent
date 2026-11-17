'use client';
import { useEffect, useId, useRef } from 'react';

// Port of the launch film's eclipse mark (nova-v1-launch-work/logo/nova-mark.js).
// Geometry comes from the app icon on a 200 viewBox: dark disk at (92,108) r54,
// light disk offset (+8,-8), highlight dot where they meet.
type State = { breathe: number; level: number; totality: number; work: number };
const STATES: Record<string, State> = {
  idle: { breathe: 1, level: 0, totality: 0, work: 0 },
  listen: { breathe: 0.4, level: 1, totality: 0, work: 0 },
  understand: { breathe: 0.6, level: 0, totality: 1, work: 0 },
  work: { breathe: 1, level: 0, totality: 0, work: 1 },
};
// Hero loop: listen while the person speaks, understand, then work.
const SEQUENCE: [keyof typeof STATES, number][] = [
  ['listen', 2.6],
  ['understand', 1.6],
  ['work', 3.4],
  ['idle', 1.4],
];
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const ease = (k: number) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);

function geometry(p: State, t: number) {
  const breathe = p.breathe * (0.5 + 0.5 * Math.sin((t * 2 * Math.PI) / 4.2));
  const tot = p.totality;
  const lvl = p.level * (0.6 + 0.4 * Math.abs(Math.sin(t * 9)));
  const off = 10.5 * (1 - tot);
  const dcx = 92 + 5.25 * tot;
  const dcy = 108 - 5.25 * tot;
  const lcx = dcx + off;
  const lcy = dcy - off;
  const lr = 54 + 2.6 * tot + 1.2 * lvl;
  const base = Math.atan2(66 - 97.5, 58 - 102.5) - 0.04;
  const a = base + 0.05 * Math.sin((t * 2 * Math.PI) / 7);
  const ar = lr + 18;
  const C = 2 * Math.PI * ar;
  return {
    dcx,
    dcy,
    lcx,
    lcy,
    lr,
    corona: lr + 2 + 3 * breathe + 7 * lvl + 4 * tot,
    coronaOpacity: 0.55 + 0.25 * breathe + 0.35 * lvl,
    dx: lcx + lr * Math.cos(a),
    dy: lcy + lr * Math.sin(a),
    dr: 2.2 + 1.4 * tot + 0.8 * lvl,
    ar,
    dash: `${C * 0.19} ${C}`,
    arcOpacity: p.work,
    rot: (t * 140) % 360,
  };
}

export function NovaMark({
  size = 40,
  animate = false,
  label,
}: {
  size?: number;
  animate?: boolean;
  label?: string;
}) {
  const id = useId().replace(/:/g, '');
  const svgRef = useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (!animate) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const total = SEQUENCE.reduce((s, [, d]) => s + d, 0);
    let raf = 0;
    const start = performance.now();
    const frame = (now: number) => {
      const t = (now - start) / 1000;
      let at = t % total;
      let i = 0;
      while (at > SEQUENCE[i][1]) at -= SEQUENCE[i++][1];
      const from = STATES[SEQUENCE[i][0]];
      const to = STATES[SEQUENCE[(i + 1) % SEQUENCE.length][0]];
      const k = ease(Math.max(0, (at - SEQUENCE[i][1] + 0.5) / 0.5));
      const p = {
        breathe: lerp(from.breathe, to.breathe, k),
        level: lerp(from.level, to.level, k),
        totality: lerp(from.totality, to.totality, k),
        work: lerp(from.work, to.work, k),
      };
      const g = geometry(p, t);
      const svg = svgRef.current;
      if (!svg) return;
      const q = (k: string) =>
        svg.querySelector<SVGElement>(`[data-part="${k}"]`);
      const r = {
        corona: q('corona'),
        light: q('light'),
        disk: q('disk'),
        dot: q('dot'),
        arc: q('arc'),
      };
      r.corona?.setAttribute('cx', `${g.lcx}`);
      r.corona?.setAttribute('cy', `${g.lcy}`);
      r.corona?.setAttribute('r', `${g.corona}`);
      r.corona?.setAttribute('opacity', g.coronaOpacity.toFixed(3));
      r.light?.setAttribute('cx', `${g.lcx}`);
      r.light?.setAttribute('cy', `${g.lcy}`);
      r.light?.setAttribute('r', `${g.lr}`);
      r.disk?.setAttribute('cx', `${g.dcx}`);
      r.disk?.setAttribute('cy', `${g.dcy}`);
      r.dot?.setAttribute('cx', `${g.dx}`);
      r.dot?.setAttribute('cy', `${g.dy}`);
      r.dot?.setAttribute('r', `${g.dr}`);
      r.arc?.setAttribute('r', `${g.ar}`);
      r.arc?.setAttribute('opacity', g.arcOpacity.toFixed(3));
      r.arc?.setAttribute('transform', `rotate(${g.rot} 96 104)`);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [animate]);

  const g = geometry(STATES.idle, 0);
  return (
    <svg
      ref={svgRef}
      className="nova-mark-svg"
      viewBox="-20 -20 240 240"
      width={size}
      height={size}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <defs>
        <filter id={`${id}g`} x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="9" />
        </filter>
        <linearGradient id={`${id}l`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#c9d6ea" />
        </linearGradient>
        <radialGradient id={`${id}d`} cx="0.4" cy="0.35" r="0.75">
          <stop offset="0" stopColor="#151b25" />
          <stop offset="1" stopColor="#0a0d12" />
        </radialGradient>
      </defs>
      <rect x="-20" y="-20" width="240" height="240" rx="54" fill="#0b0f16" />
      <circle
        data-part="corona"
        cx={g.lcx}
        cy={g.lcy}
        r={g.corona}
        fill="#dfe8f6"
        opacity={g.coronaOpacity}
        filter={`url(#${id}g)`}
      />
      <circle
        data-part="light"
        cx={g.lcx}
        cy={g.lcy}
        r={g.lr}
        fill={`url(#${id}l)`}
      />
      <circle
        data-part="disk"
        cx={g.dcx}
        cy={g.dcy}
        r={54}
        fill={`url(#${id}d)`}
      />
      <circle
        data-part="arc"
        cx={96}
        cy={104}
        r={g.ar}
        fill="none"
        stroke="#8fb4ff"
        strokeWidth={5}
        strokeLinecap="round"
        strokeDasharray={g.dash}
        opacity={0}
      />
      <circle data-part="dot" cx={g.dx} cy={g.dy} r={g.dr} fill="#fff" />
    </svg>
  );
}
