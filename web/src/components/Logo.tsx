import { useId } from "react";

/** Coin-with-keyhole mark: the purse strings, held. */
export function LogoMark({ size = 32 }: { size?: number }) {
  const id = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="Purser">
      <defs>
        <linearGradient id={`g${id}`} x1="8" y1="6" x2="56" y2="58" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#a99cff" />
          <stop offset="1" stopColor="#5b49e8" />
        </linearGradient>
      </defs>
      <circle cx="32" cy="32" r="29" fill={`url(#g${id})`} />
      <circle cx="32" cy="32" r="23.5" fill="none" stroke="#070a0f" strokeOpacity=".35" strokeWidth="2" />
      <path fill="#070a0f" d="M32 17.5a8 8 0 0 0-4.2 14.8L25.6 46.5h12.8l-2.2-14.2A8 8 0 0 0 32 17.5Z" />
    </svg>
  );
}

export function Logo({ size = 30, tagline = false }: { size?: number; tagline?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <LogoMark size={size} />
      <div className="leading-none">
        <div className="text-[1.15rem] font-semibold tracking-tight text-fg">Purser</div>
        {tagline && <div className="mt-1 text-[11px] tracking-wide text-mute">keeps the books</div>}
      </div>
    </div>
  );
}
