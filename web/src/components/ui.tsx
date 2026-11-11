import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { IconX } from "./icons";

type Tone = "primary" | "ghost" | "allow" | "deny" | "escalate" | "subtle";
const TONES: Record<Tone, string> = {
  primary: "bg-accent text-white hover:bg-accent-hi hover:text-base shadow-[0_0_0_1px_rgb(169_156_255/0.35),0_8px_24px_-8px_rgb(124_108_255/0.7)]",
  ghost: "border border-line-strong text-fg hover:bg-hover hover:border-dim/50",
  subtle: "text-dim hover:text-fg hover:bg-hover",
  allow: "bg-allow text-base hover:brightness-110 shadow-[0_8px_24px_-10px_rgb(61_220_151/0.8)]",
  escalate: "bg-escalate text-base hover:brightness-110",
  deny: "bg-deny text-base hover:brightness-110 shadow-[0_8px_24px_-10px_rgb(255_93_108/0.8)]",
};

export function Button({ tone = "ghost", size = "md", busy, className = "", children, disabled, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone; size?: "sm" | "md" | "lg"; busy?: boolean }) {
  const sz = size === "lg" ? "h-12 px-6 text-[15px]" : size === "sm" ? "h-8 px-3 text-xs" : "h-10 px-4 text-sm";
  return (
    <button
      {...rest}
      disabled={disabled || busy}
      className={`focus-ring inline-flex select-none items-center justify-center gap-2 rounded-lg font-semibold transition duration-150 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-45 ${sz} ${TONES[tone]} ${className}`}
    >
      {busy && <span className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}
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
      {icon && <div className="mb-4 grid size-14 place-items-center rounded-2xl border border-line-strong bg-raised text-accent-hi">{icon}</div>}
      <h3 className="text-base font-semibold text-fg">{title}</h3>
      {children && <p className="mt-1.5 text-sm leading-relaxed text-dim">{children}</p>}
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
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div ref={ref} tabIndex={-1} className={`relative animate-rise rounded-2xl border bg-panel p-6 shadow-[0_30px_80px_-20px_rgb(0_0_0/0.9)] outline-none ${wide ? "w-[min(760px,100%)]" : "w-[min(480px,100%)]"} ${tone === "danger" ? "border-deny/50" : "border-line-strong"}`}>
        <button onClick={onClose} aria-label="Close" className="focus-ring absolute right-4 top-4 grid size-8 place-items-center rounded-lg text-dim hover:bg-hover hover:text-fg">
          <IconX size={16} />
        </button>
        {children}
      </div>
    </div>
  );
}

export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; hint?: string; disabled?: boolean }[]; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg border border-line-strong bg-sunken p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          title={o.hint}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
          className={`focus-ring rounded-md px-3.5 py-1.5 text-[13px] font-semibold transition disabled:opacity-40 ${value === o.value ? "bg-accent text-white shadow" : "text-dim hover:text-fg"}`}
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
      className={`focus-ring relative h-6 w-11 shrink-0 rounded-full border transition disabled:opacity-50 ${checked ? "border-deny/60 bg-deny/25" : "border-line-strong bg-sunken"}`}
    >
      <span className={`absolute top-0.5 size-4.5 rounded-full transition-all ${checked ? "left-[22px] bg-deny" : "left-0.5 bg-dim"}`} />
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
