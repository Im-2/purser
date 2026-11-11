import { useEffect, useRef, useState } from "react";
import { navigate } from "../lib/route";
import { useStore } from "../lib/store";
import { Skeleton } from "./ui";

type Tone = "allow" | "deny" | "escalate" | "neutral" | "ink";
const TEXT: Record<Tone, string> = { allow: "text-allow", deny: "text-deny", escalate: "text-escalate", neutral: "text-fg", ink: "text-on-ink" };
const DOT: Record<Tone, string> = { allow: "bg-allow", deny: "bg-deny", escalate: "bg-escalate", neutral: "bg-mute", ink: "bg-lime" };

/** Smoothly counts from the previous value to the new one (text only, no layout work, so it stays at 60fps). */
function useCountUp(target: number, ms = 900): number {
  const [v, setV] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      from.current = target;
      setV(target);
      return;
    }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / ms);
      const e = 1 - Math.pow(1 - k, 3);
      const cur = a + (target - a) * e;
      from.current = cur;
      setV(cur);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}

function Count({ value, money, decimals = 0 }: { value: number; money?: boolean; decimals?: number }) {
  const v = useCountUp(value);
  const txt = v.toFixed(decimals).replace(/B(?=(d{3})+(?!d))/g, ",");
  return <>{money ? "$" : ""}{txt}</>;
}

function Stat({ label, value, money, sub, tone, index, onClick }: { label: string; value: number; money?: boolean; sub: string; tone: Tone; index: number; onClick?: () => void }) {
  const Tag = onClick ? "button" : "div";
  const ink = tone === "ink";
  return (
    <Tag
      onClick={onClick}
      style={{ "--i": index } as React.CSSProperties}
      className={`rise relative px-6 py-5 text-left ${ink ? "panel-ink" : "panel"} ${onClick ? `focus-ring transition duration-[var(--duration-base)] ease-soft hover:-translate-y-0.5 ${ink ? "" : "hover:bg-hover"}` : ""}`}
    >
      <div className={`flex items-center gap-2 text-[12px] font-medium ${ink ? "text-on-ink/70" : "text-mute"}`}>
        <span className={`size-2 rounded-full ${DOT[tone]}`} />
        {label}
      </div>
      <div className={`num mt-3 text-[2.4rem] font-normal leading-none tracking-[-0.04em] ${TEXT[tone]}`}>
        <Count value={value} money={money} decimals={money ? 2 : 0} />
      </div>
      <div className={`mt-2.5 text-xs ${ink ? "text-on-ink/60" : "text-mute"}`}>{sub}</div>
    </Tag>
  );
}

export function StatsStrip() {
  const { state } = useStore();
  const s = state.stats;
  if (!s) {
    return (
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="panel px-6 py-5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-3 h-8 w-32" />
            <Skeleton className="mt-3 h-3 w-40" />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
      <Stat index={0} label="Spent today" value={Number(s.spend_today)} money sub="allowed payouts and refunds executed" tone="ink" />
      <Stat index={1} label="Blocked today" value={s.blocked_count} sub="calls denied before any money moved" tone="deny" />
      <Stat index={2} label="Blocked amount" value={Number(s.blocked_amount)} money sub="what those calls would have moved" tone="deny" />
      <Stat index={3} label="Pending approvals" value={s.pending_approvals} sub={s.pending_approvals ? "waiting for a human, tap to review" : "nothing waiting on you"} tone={s.pending_approvals ? "escalate" : "neutral"} onClick={() => navigate("approvals")} />
    </div>
  );
}
