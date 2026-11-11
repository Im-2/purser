import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { IconX } from "./icons";

type Tone = "primary" | "ghost" | "allow" | "deny" | "escalate" | "subtle";
/** Buttons are pills. Primary is the near-black pill; secondary is an outline pill; decision buttons are solid deep colours. */
const TONES: Record<Tone, string> = {
  primary: "bg-ink text-on-ink shadow-pill hover:bg-ink-soft",
  ghost: "border border-line-strong bg-panel text-fg hover:border-lime-line hover:bg-hover",
  subtle: "text-dim hover:bg-hover hover:text-fg",
  allow: "bg-allow text-white shadow-soft hover:brightness-110",
  escalate: "bg-escalate text-white hover:brightness-110",
  deny: "bg-deny-solid text-white shadow-red hover:brightness-105",
};

export function Button({ tone = "ghost", size = "md", busy, className = "", children, disabled, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone; size?: "sm" | "md" | "lg"; busy?: boolean }) {
  const sz = size === "lg" ? "h-12 px-7 text-[15px]" : size === "sm" ? "h-8 px-3.5 text-xs" : "h-10 px-5 text-sm";
  return (
    <button
      {...rest}
      disabled={disabled || busy}
      className={`focus-ring inline-flex select-none items-center justify-center gap-2 rounded-full font-medium tracking-tight transition duration-[var(--duration-fast)] ease-soft active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-45 ${sz} ${TONES[tone]} ${className}`}
    >
      {busy && <span className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}
      {children}
    </button>
  );
}

/** Small round icon button, as used in the header. */
export function RoundButton({ label, className = "", children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button {...rest} aria-label={label} title={label} className={`focus-ring grid size-10 shrink-0 place-items-center rounded-full border border-line-strong bg-panel text-dim transition duration-[var(--duration-fast)] hover:border-lime-line hover:bg-hover hover:text-fg ${className}`}>
      {children}
    </button>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton ${className}`} />;
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-6 py-14 text-center">
      {icon && <div className="float mb-5 grid size-16 place-items-center rounded-full bg-lime text-accent-hi shadow-soft">{icon}</div>}
      <h3 className="text-xl text-fg">{title}</h3>
      {children && <p className="mt-2 text-sm leading-relaxed text-dim">{children}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/** Accessible modal: Escape closes, focus moves in and returns, backdrop click closes. */
export function Modal({ open, onClose, title, children, wide, tone = "default" }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean; tone?: "default" | "danger" }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-ink/35 backdrop-blur-md" onClick={onClose} />
      <div ref={ref} tabIndex={-1} className={`rise relative rounded-panel border bg-panel p-7 shadow-lift outline-none ${wide ? "w-[min(760px,100%)]" : "w-[min(480px,100%)]"} ${tone === "danger" ? "border-deny-line" : "border-line"}`}>
        <button onClick={onClose} aria-label="Close" className="focus-ring absolute right-5 top-5 grid size-9 place-items-center rounded-full border border-line-strong text-dim transition hover:bg-hover hover:text-fg">
          <IconX size={15} />
        </button>
        {children}
      </div>
    </div>
  );
}

/** Pill segmented control. The selected segment is the near-black pill. */
export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; hint?: string; disabled?: boolean }[]; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-full border border-line-strong bg-sunken p-1">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          title={o.hint}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
          className={`focus-ring rounded-full px-4 py-1.5 text-[13px] font-medium transition duration-[var(--duration-fast)] disabled:opacity-40 ${value === o.value ? "bg-ink text-on-ink shadow-pill" : "text-dim hover:bg-hover hover:text-fg"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, label, busy }: { checked: boolean; onChange: (v: boolean) => void; label: string; busy?: boolean }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={busy}
      onClick={() => onChange(!checked)}
      className={`focus-ring relative h-6 w-11 shrink-0 rounded-full border transition duration-[var(--duration-fast)] disabled:opacity-50 ${checked ? "border-deny-line bg-deny-soft" : "border-line-strong bg-sunken"}`}
    >
      <span className={`absolute top-0.5 size-4.5 rounded-full shadow transition-all duration-[var(--duration-fast)] ${checked ? "left-[22px] bg-deny-solid" : "left-0.5 bg-ink"}`} />
    </button>
  );
}

export function KeyValue({ k, children, mono }: { k: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[104px_1fr] gap-3 py-1.5 text-[13px]">
      <dt className="text-mute">{k}</dt>
      <dd className={`min-w-0 break-words text-fg ${mono ? "num" : ""}`}>{children}</dd>
    </div>
  );
}
