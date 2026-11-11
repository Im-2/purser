import { useState } from "react";
import { useActions } from "../lib/actions";
import { relTime } from "../lib/format";
import { useStore } from "../lib/store";
import type { AgentInfo } from "../lib/types";
import { IconRobot } from "./icons";
import { Skeleton, Switch } from "./ui";

function FreezeReason({ a }: { a: AgentInfo }) {
  if (a.effective_status !== "frozen") return null;
  const f = a.freeze;
  const d = f?.detail as { denies?: number; window_sec?: number } | undefined;
  const text =
    f?.reason === "circuit_breaker" ? `Circuit breaker: ${d?.denies ?? "several"} denies in ${d?.window_sec ?? "?"}s` : f?.reason === "freeze_all" ? "Kill switch pressed" : f?.reason === "admin" ? "Frozen by an operator" : "Frozen";
  return (
    <div className="mt-2 rounded-lg border border-deny/35 bg-deny/8 px-2.5 py-1.5 text-xs text-deny">
      {text}
      {f?.at && <span className="text-deny/70"> · {relTime(f.at)}</span>}
    </div>
  );
}

export function AgentsPanel() {
  const { state } = useStore();
  const actions = useActions();
  const [busyId, setBusyId] = useState<string | null>(null);

  return (
    <section className="panel p-3 min-[1700px]:p-4" aria-label="Agents">
      <div className="mb-2 flex items-center justify-between min-[1700px]:mb-3">
        <h2 className="eyebrow">Agents</h2>
        <span className="num text-xs text-mute">{state.agents.length}</span>
      </div>

      {!state.ready && state.agents.length === 0 && (
        <div className="space-y-3">
          <Skeleton className="h-16" />
        </div>
      )}
      {state.ready && state.agents.length === 0 && <p className="py-4 text-sm text-dim">No agents yet. Seed one with <span className="num text-fg">pnpm --filter @purser/server seed</span>.</p>}

      <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 min-[1700px]:grid-cols-1">
        {state.agents.map((a) => {
          const frozen = a.effective_status === "frozen";
          return (
            <li key={a.id} className={`rounded-xl border p-3 transition ${frozen ? "border-deny/40 bg-deny/5" : "border-line bg-raised/50"}`}>
              <div className="flex items-start gap-3">
                <div className={`grid size-9 shrink-0 place-items-center rounded-lg border ${frozen ? "border-deny/40 text-deny" : "border-accent/40 text-accent-hi"} bg-sunken`}>
                  <IconRobot size={17} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold">{a.name}</span>
                    <span className={`rounded px-1.5 py-px text-[10px] font-bold uppercase tracking-wider ${frozen ? "bg-deny/20 text-deny" : "bg-allow/15 text-allow"}`}>{frozen ? "frozen" : "active"}</span>
                  </div>
                  <div className="num mt-0.5 truncate text-[11px] text-mute">{a.id}</div>
                  {a.mandate && <p className="mt-1.5 line-clamp-2 text-xs leading-snug text-dim">{a.mandate}</p>}
                </div>
                <Switch
                  checked={frozen}
                  busy={busyId === a.id}
                  label={frozen ? `Unfreeze ${a.name}` : `Freeze ${a.name}`}
                  onChange={async (v) => {
                    setBusyId(a.id);
                    await actions.setAgentFrozen(a.id, a.name, v);
                    setBusyId(null);
                  }}
                />
              </div>
              <FreezeReason a={a} />
              {a.pending_approvals > 0 && <div className="mt-2 text-xs text-escalate">{a.pending_approvals} approval{a.pending_approvals > 1 ? "s" : ""} waiting</div>}
            </li>
          );
        })}
      </ul>
      <p className="mt-3 hidden text-[11.5px] leading-snug text-mute min-[1700px]:block">The switch freezes one agent. Use the red button in the header to freeze them all.</p>
    </section>
  );
}
