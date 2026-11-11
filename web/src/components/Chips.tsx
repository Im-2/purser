import type { ReactNode } from "react";
import { RULE_LABEL, SIGNAL_LABEL, STAGE_LABEL, label } from "../lib/format";
import type { Decision, SignalDetail } from "../lib/types";
import { IconAlert, IconCheck, IconX } from "./icons";

const DEC: Record<Decision, { text: string; cls: string; icon: ReactNode }> = {
  allow: { text: "ALLOW", cls: "border-allow/40 bg-allow/12 text-allow", icon: <IconCheck size={12} strokeWidth={2.6} /> },
  escalate: { text: "ESCALATE", cls: "border-escalate/45 bg-escalate/12 text-escalate", icon: <IconAlert size={12} strokeWidth={2.4} /> },
  deny: { text: "DENY", cls: "border-deny/45 bg-deny/12 text-deny", icon: <IconX size={12} strokeWidth={2.6} /> },
};

export function DecisionChip({ decision, size = "sm" }: { decision: Decision; size?: "sm" | "lg" }) {
  const d = DEC[decision];
  return (
    <span className={`inline-flex items-center gap-1 rounded-md border font-bold tracking-wider ${size === "lg" ? "px-3 py-1 text-xs" : "px-2 py-0.5 text-[10.5px]"} ${d.cls}`}>
      {d.icon}
      {d.text}
    </span>
  );
}

const SEVERITY_CLS = {
  info: "border-line-strong bg-raised text-dim",
  escalate: "border-escalate/40 bg-escalate/10 text-escalate",
  deny: "border-deny/40 bg-deny/10 text-deny",
} as const;

/** Signal chip. Lookalike and mismatch signals are amber by default; first-time-payee is informational. */
export function SignalChip({ id, severity, title }: { id: string; severity?: "info" | "escalate" | "deny"; title?: string }) {
  const sev = severity ?? (id === "first_time_payee" ? "info" : "escalate");
  return (
    <span title={title} className={`inline-flex items-center whitespace-nowrap rounded-md border px-2 py-0.5 text-[11px] font-medium ${SEVERITY_CLS[sev]}`}>
      {label(SIGNAL_LABEL, id)}
    </span>
  );
}

export function signalId(s: SignalDetail): string {
  return typeof s === "string" ? s : s.id;
}

export function RuleChip({ id, severity }: { id: string; severity?: "deny" | "escalate" }) {
  const sev = severity ?? "deny";
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-md border px-2 py-0.5 text-[11px] font-medium ${SEVERITY_CLS[sev]}`}>{label(RULE_LABEL, id)}</span>
  );
}

export function StageChip({ stage }: { stage: string }) {
  return <span className="inline-flex items-center rounded-md border border-line-strong bg-sunken px-2 py-0.5 text-[11px] font-medium text-dim">{label(STAGE_LABEL, stage)}</span>;
}

export function ModeChip({ mode }: { mode: "replay" | "live" }) {
  return mode === "live" ? (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-accent/50 bg-accent/12 px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wider text-accent-hi">
      <span className="size-1.5 rounded-full bg-accent-hi" />
      live agent
    </span>
  ) : (
    <span className="inline-flex items-center rounded-md border border-line-strong bg-raised px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wider text-dim">replay</span>
  );
}

/** Risk 0-100 as a small bar plus a mono number. Colour follows the reviewer's own thresholds (30 / 75). */
export function RiskMeter({ risk }: { risk: number }) {
  const tone = risk >= 75 ? "bg-deny" : risk >= 30 ? "bg-escalate" : "bg-allow";
  const text = risk >= 75 ? "text-deny" : risk >= 30 ? "text-escalate" : "text-allow";
  return (
    <div className="flex items-center gap-2" aria-label={`risk ${risk} of 100`}>
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-sunken">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.max(3, Math.min(100, risk))}%` }} />
      </div>
      <span className={`num text-xs font-semibold ${text}`}>{risk}</span>
    </div>
  );
}
