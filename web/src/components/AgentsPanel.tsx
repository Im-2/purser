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
    <div className="mt-2 rounded-2xl border border-deny-line bg-deny-soft px-2.5 py-1.5 text-xs text-deny">
      {text}
      {f?.at && <span className="text-deny/70"> · {relTime(f.at)}</span>}
    </div>
  );
}

/**
 * Agents. Below 1700px this is a slim row of compact chips (one per agent, wrapping, scales to many agents).
 * From 1700px up it is a sidebar card list with the mandate and the freeze reason.
 */
export function AgentsPanel() {
  const { state } = useStore();
  const actions = useActions();
  const [busyId, setBusyId] = useState<string | null>(null);

  return (
    <section className="min-[1700px]:panel min-[1700px]:p-4" aria-label="Agents">
      <div className="mb-3 hidden items-center justify-between min-[1700px]:flex">
        <h2 className="eyebrow">Agents</h2>
        <span className="num text-xs text-mute">{state.agents.length}</span>
      </div>

      {!state.ready && state.agents.length === 0 && <Skeleton className="h-12 w-72" />}
      {state.ready && state.agents.length === 0 && (
        <p className="rounded-full border border-line-strong bg-panel px-4 py-2 text-sm text-dim shadow-soft min-[1700px]:rounded-[22px] min-[1700px]:border-0 min-[1700px]:bg-transparent min-[1700px]:py-4 min-[1700px]:shadow-none">
          No agents yet. Seed one with <span className="num text-fg">pnpm --filter @purser/server seed</span>.
        </p>
      )}

      <ul className="flex flex-wrap items-center gap-2.5 min-[1700px]:flex-col min-[1700px]:items-stretch min-[1700px]:gap-3">
        <li className="eyebrow mr-1 min-[1700px]:hidden">Agents</li>
        {state.agents.map((a) => {
          const frozen = a.effective_status === "frozen";
          const reason = a.freeze?.reason === "circuit_breaker" ? "circuit breaker" : a.freeze?.reason === "freeze_all" ? "kill switch" : a.freeze?.reason === "admin" ? "operator" : "";
          return (
            <li
              key={a.id}
              title={a.mandate ?? a.name}
              className={`flex items-center gap-2.5 rounded-full border py-1.5 pl-1.5 pr-3 shadow-soft transition duration-[var(--duration-base)] min-[1700px]:flex-wrap min-[1700px]:rounded-[22px] min-[1700px]:px-3.5 min-[1700px]:py-3 ${frozen ? "border-deny-line bg-deny-soft" : "border-line bg-panel min-[1700px]:bg-raised/60 min-[1700px]:shadow-none"}`}
            >
              <div className={`grid size-8 shrink-0 place-items-center rounded-full ${frozen ? "bg-panel text-deny" : "bg-lime text-accent-hi"}`}>
                <IconRobot size={16} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13.5px] font-medium">{a.name}</span>
                  <span className={`rounded-full px-2 py-px text-[10px] font-semibold uppercase tracking-wider ${frozen ? "bg-panel text-deny" : "bg-allow-soft text-allow"}`}>{frozen ? `frozen${reason ? ` · ${reason}` : ""}` : "active"}</span>
                  {a.pending_approvals > 0 && <span className="num rounded-full bg-escalate-soft px-2 py-px text-[10.5px] text-escalate">{a.pending_approvals} waiting</span>}
                </div>
                <div className="num hidden truncate text-[11px] text-mute min-[1700px]:block">{a.id}</div>
                {a.mandate && <p className="mt-1 hidden text-xs leading-snug text-dim min-[1700px]:line-clamp-2 min-[1700px]:block">{a.mandate}</p>}
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
              <div className="hidden w-full min-[1700px]:block">
                <FreezeReason a={a} />
              </div>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 hidden text-[11.5px] leading-snug text-mute min-[1700px]:block">The switch freezes one agent. Use the red button in the header to freeze them all.</p>
    </section>
  );
}
