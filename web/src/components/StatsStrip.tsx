import { useEffect, useRef, useState } from "react";
import { navigate } from "../lib/route";
import { useStore } from "../lib/store";
import { Skeleton } from "./ui";

type Tone = "allow" | "deny" | "escalate" | "neutral";
const RING: Record<Tone, string> = { allow: "before:bg-allow", deny: "before:bg-deny", escalate: "before:bg-escalate", neutral: "before:bg-accent" };
const TEXT: Record<Tone, string> = { allow: "text-allow", deny: "text-deny", escalate: "text-escalate", neutral: "text-fg" };

/** Brief brightness pulse whenever the value changes, so live updates are noticeable without being noisy. */
function useTick(value: string): boolean {
  const prev = useRef(value);
  const [tick, setTick] = useState(false);
  useEffect(() => {
    if (prev.current !== value) {
      prev.current = value;
      setTick(true);
      const t = setTimeout(() => setTick(false), 700);
      return () => clearTimeout(t);
    }
  }, [value]);
  return tick;
}

function Stat({ label, value, sub, tone, onClick }: { label: string; value: string; sub: string; tone: Tone; onClick?: () => void }) {
  const tick = useTick(value);
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      onClick={onClick}
      className={`panel relative overflow-hidden px-5 py-4 text-left before:absolute before:inset-y-4 before:left-0 before:w-[3px] before:rounded-r-full ${RING[tone]} ${onClick ? "focus-ring transition hover:border-line-strong hover:bg-raised" : ""}`}
    >
      <div className="eyebrow">{label}</div>
      <div className={`num mt-2 text-[2rem] font-semibold leading-none transition-all duration-500 ${TEXT[tone]} ${tick ? "scale-[1.04] brightness-125" : ""}`} style={{ transformOrigin: "left center" }}>
        {value}
      </div>
      <div className="mt-2 text-xs text-mute">{sub}</div>
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
          <div key={i} className="panel px-5 py-4">
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
      <Stat label="Spent today" value={`$${s.spend_today.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`} sub="allowed payouts and refunds executed" tone="allow" />
      <Stat label="Blocked today" value={String(s.blocked_count)} sub="calls denied before any money moved" tone="deny" />
      <Stat label="Blocked amount" value={`$${s.blocked_amount.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`} sub="what those calls would have moved" tone="deny" />
      <Stat label="Pending approvals" value={String(s.pending_approvals)} sub={s.pending_approvals ? "waiting for a human, tap to review" : "nothing waiting on you"} tone={s.pending_approvals ? "escalate" : "neutral"} onClick={() => navigate("approvals")} />
    </div>
  );
}
