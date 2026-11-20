import { useId } from 'react';

// The app's eclipse, redrawn as vector from the 1024 px app icon's geometry
// (nova-v1-launch-work/logo/nova-mark.js, idle state): a dark disc, a white
// disc of the same radius offset up and right, a blurred corona, and the bead
// where the two meet. On the light theme a round night-sky disc sits behind it
// (opacity from --eclipse-sky), since the white crescent vanishes on paper.
export function EclipseMark({ className }: { className?: string }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg
      className={className}
      viewBox="14 10 176 176"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <radialGradient id={`${id}k`} cx="0.42" cy="0.32" r="0.75">
          <stop offset="0" stopColor="#1d2a3e" />
          <stop offset="1" stopColor="#0b0f16" />
        </radialGradient>
        <filter id={`${id}g`} x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="9" />
        </filter>
        <filter id={`${id}s`} x="-100%" y="-100%" width="300%" height="300%">
          <feGaussianBlur stdDeviation="3.2" />
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
      <circle
        cx="102"
        cy="98"
        r="86"
        fill={`url(#${id}k)`}
        style={{ opacity: 'var(--eclipse-sky)' }}
      />
      <circle
        cx="102.5"
        cy="97.5"
        r="57.5"
        fill="#dfe8f6"
        opacity="0.68"
        filter={`url(#${id}g)`}
      />
      <circle cx="102.5" cy="97.5" r="54" fill={`url(#${id}l)`} />
      <circle
        cx="92"
        cy="108"
        r="54"
        fill={`url(#${id}d)`}
        stroke="rgba(255,255,255,.08)"
        strokeWidth="0.6"
      />
      <circle cx="57.2" cy="68.1" r="6.2" fill="#fff" filter={`url(#${id}s)`} />
      <circle cx="57.2" cy="68.1" r="2.2" fill="#fff" />
    </svg>
  );
}
