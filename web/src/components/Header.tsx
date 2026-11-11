import { useState } from "react";
import { useActions } from "../lib/actions";
import { navigate, type RouteId } from "../lib/route";
import { useStore } from "../lib/store";
import { Logo } from "./Logo";
import { IconInfo, IconSignOut, IconSnow } from "./icons";
import { Button, Modal } from "./ui";

const NAV: { id: RouteId; label: string; soon?: boolean }[] = [
  { id: "live", label: "Live" },
  { id: "approvals", label: "Approvals" },
  { id: "lab", label: "Attack Lab" },
  { id: "policies", label: "Policies", soon: true },
  { id: "reconciliation", label: "Reconciliation", soon: true },
];

function ConnectionPill() {
  const { state } = useStore();
  const c = state.conn;
  const tone = c === "live" ? "text-allow" : c === "connecting" ? "text-dim" : "text-escalate";
  return (
    <span className={`hidden items-center gap-2 rounded-full border border-line px-3 py-1 text-xs font-medium md:inline-flex ${tone}`} title="Server-sent events connection">
      <span className={`size-2 rounded-full bg-current ${c === "live" ? "animate-pulse-ring" : ""}`} />
      {c === "live" ? "Live" : c === "connecting" ? "Connecting" : "Reconnecting"}
    </span>
  );
}

export function Header({ route, onHow, onLogout }: { route: RouteId; onHow: () => void; onLogout: () => void }) {
  const { state } = useStore();
  const actions = useActions();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = state.approvals.filter((a) => a.status === "pending").length;
  const frozen = state.globalFreeze || state.agents.some((a) => a.effective_status === "frozen");

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-base/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-[1800px] items-center gap-3 px-4 sm:px-6">
        <a href="#/live" className="focus-ring mr-1 rounded-lg sm:mr-4" aria-label="Purser home">
          <Logo />
        </a>

        <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" aria-label="Primary">
          {NAV.map((n) => {
            const active = route === n.id;
            return (
              <button
                key={n.id}
                onClick={() => navigate(n.id)}
                aria-current={active ? "page" : undefined}
                className={`focus-ring relative flex shrink-0 items-center gap-2 rounded-lg px-3.5 py-2 text-[13.5px] font-semibold transition ${active ? "bg-raised text-fg" : "text-dim hover:bg-hover hover:text-fg"}`}
              >
                {n.label}
                {n.id === "approvals" && pending > 0 && <span className="num grid min-w-5 place-items-center rounded-full bg-escalate px-1.5 text-[11px] font-bold leading-5 text-base">{pending}</span>}
                {n.soon && <span className="rounded border border-line-strong px-1.5 py-px text-[9px] font-bold uppercase tracking-wider text-mute">soon</span>}
                {active && <span className="absolute inset-x-3 -bottom-[13px] h-0.5 rounded-full bg-accent" />}
              </button>
            );
          })}
        </nav>

        <ConnectionPill />
        <button onClick={onHow} className="focus-ring hidden items-center gap-1.5 rounded-lg px-2.5 py-2 text-[13px] font-medium text-dim transition hover:bg-hover hover:text-fg lg:inline-flex">
          <IconInfo size={15} /> How this works
        </button>
        <button onClick={onLogout} className="focus-ring grid size-9 place-items-center rounded-lg text-dim transition hover:bg-hover hover:text-fg" aria-label="Sign out" title="Sign out">
          <IconSignOut size={16} />
        </button>

        <button
          onClick={() => (frozen ? undefined : setConfirm(true))}
          disabled={frozen}
          className={`focus-ring inline-flex h-10 shrink-0 items-center gap-2 rounded-lg px-4 text-[13px] font-extrabold tracking-wider transition ${frozen ? "cursor-default border border-deny/50 bg-deny/10 text-deny" : "bg-deny text-base shadow-[0_0_0_1px_rgb(255_93_108/0.6),0_8px_28px_-6px_rgb(255_93_108/0.75)] hover:brightness-110 active:translate-y-px"}`}
          title={frozen ? "Agents are frozen" : "Freeze every agent immediately"}
        >
          <IconSnow size={15} strokeWidth={2.4} />
          <span className="hidden sm:inline">{frozen ? "FROZEN" : "KILL SWITCH"}</span>
        </button>
      </div>

      <Modal open={confirm} onClose={() => setConfirm(false)} title="Freeze all agents" tone="danger">
        <div className="flex items-start gap-4">
          <div className="grid size-11 shrink-0 place-items-center rounded-xl border border-deny/50 bg-deny/12 text-deny">
            <IconSnow size={22} />
          </div>
          <div>
            <h2 className="text-lg font-semibold">Freeze every agent now?</h2>
            <p className="mt-1.5 text-sm leading-relaxed text-dim">
              From this moment every tool call from every agent is denied at the first stage, before any rule runs. Nothing is approved, paid or refunded until you unfreeze.
            </p>
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-2.5">
          <Button onClick={() => setConfirm(false)}>Cancel</Button>
          <Button
            tone="deny"
            busy={busy}
            onClick={async () => {
              setBusy(true);
              await actions.freezeAll();
              setBusy(false);
              setConfirm(false);
            }}
          >
            <IconSnow size={15} strokeWidth={2.4} /> Freeze all agents
          </Button>
        </div>
      </Modal>
    </header>
  );
}
