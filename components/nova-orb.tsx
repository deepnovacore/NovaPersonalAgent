// Decorative Nova mark for the hero: concentric rings that breathe. Pure CSS,
// so it is disabled by the global prefers-reduced-motion rule.
export function NovaOrb() {
  return (
    <div className="nova-orb" aria-hidden="true">
      <span className="ring r1" />
      <span className="ring r2" />
      <span className="ring r3" />
      <span className="core" />
    </div>
  );
}
