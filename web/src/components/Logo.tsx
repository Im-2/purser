import { useId } from "react";

/**
 * The Purser mark: a soft clay coin with a keyhole. Pure SVG (gradients and a blurred contact shadow), no raster assets.
 * `shadow` adds the soft ground shadow, used for the large hero coin.
 */
export function LogoMark({ size = 32, shadow = false }: { size?: number; shadow?: boolean }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" role="img" aria-label="Purser" overflow="visible">
      <defs>
        <radialGradient id={`f${id}`} cx="34%" cy="26%" r="85%">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.45" stopColor="#f3f3ee" />
          <stop offset="1" stopColor="#d6d6cd" />
        </radialGradient>
        <linearGradient id={`e${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#e4e4dc" />
          <stop offset="1" stopColor="#bdbdb2" />
        </linearGradient>
        <linearGradient id={`r${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#c9c9bf" />
          <stop offset="1" stopColor="#ffffff" />
        </linearGradient>
        <radialGradient id={`i${id}`} cx="50%" cy="38%" r="70%">
          <stop offset="0" stopColor="#f4f4ef" />
          <stop offset="1" stopColor="#e2e2d9" />
        </radialGradient>
        <filter id={`b${id}`} x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="3.2" />
        </filter>
      </defs>
      {shadow && <ellipse cx="50" cy="96" rx="30" ry="4.5" fill="#131316" opacity="0.2" filter={`url(#b${id})`} />}
      {/* thickness */}
      <circle cx="50" cy="55.5" r="40" fill={`url(#e${id})`} />
      {/* face */}
      <circle cx="50" cy="50" r="40" fill={`url(#f${id})`} />
      {/* bevelled rim and recessed centre */}
      <circle cx="50" cy="50" r="31" fill={`url(#i${id})`} stroke={`url(#r${id})`} strokeWidth="2.6" />
      {/* keyhole */}
      <path fill="#131316" d="M50 36.5a8.4 8.4 0 0 0-4.5 15.5L43.6 66.5h12.8L54.5 52A8.4 8.4 0 0 0 50 36.5Z" />
      <path fill="#fff" opacity=".18" d="M46.2 41.2a4.6 4.6 0 0 1 4.6-2.3 4.6 4.6 0 0 0-3.4 2.9Z" />
    </svg>
  );
}

export function Logo({ size = 30, tagline = false }: { size?: number; tagline?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <LogoMark size={size} />
      <div className="leading-none">
        <div className="text-[1.2rem] font-medium tracking-[-0.04em] text-fg">Purser</div>
        {tagline && <div className="mt-1 text-[11px] tracking-wide text-mute">keeps the books</div>}
      </div>
    </div>
  );
}
