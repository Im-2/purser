/** Fixed grey backdrop with a few thin pale-lime arcs, as in the reference. Pure SVG, behind everything. */
export function Backdrop() {
  return (
    <svg aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10 h-full w-full" preserveAspectRatio="none" viewBox="0 0 1440 900" fill="none">
      <g stroke="var(--color-arc)" strokeWidth="1.4">
        <circle cx="210" cy="-150" r="420" />
        <circle cx="1280" cy="1040" r="520" />
        <path d="M-80 640C260 520 520 760 820 700S1260 520 1520 600" />
        <circle cx="760" cy="-380" r="560" />
      </g>
    </svg>
  );
}
