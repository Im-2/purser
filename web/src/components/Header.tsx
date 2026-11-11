import { useState, type ReactNode } from "react";
import { useActions } from "../lib/actions";
import { navigate, type RouteId } from "../lib/route";
import { useStore } from "../lib/store";
import { Logo } from "./Logo";
import { IconInbox, IconFlask, IconInfo, IconPulse, IconScale, IconSignOut, IconSliders, IconSnow } from "./icons";
import { Button, Modal, RoundButton } from "./ui";

const NAV: { id: RouteId; label: string; icon: ReactNode; soon?: boolean }[] = [
  { id: "live", label: "Live", icon: <IconPulse size={15} /> },
  { id: "approvals", label: "Approvals", icon: <IconInbox size={15} /> },
  { id: "lab", label: "Attack Lab", icon: <IconFlask size={15} /> },
  { id: "policies", label: "Policies", icon: <IconSliders size={15} />, soon: true },
  { id: "reconciliation", label: "Reconciliation", icon: <IconScale size={15} />, soon: true },
];

function ConnectionPill() {
  const { state } = useStore();
  const c = state.conn;
  const tone = c === "live" ? "text-allow" : c === "connecting" ? "text-dim" : "text-escalate";
  return (
    <span className={`hidden items-center gap-2 rounded-full border border-line-strong bg-panel px-3.5 py-2 text-xs font-medium xl:inline-flex ${tone}`} title="Server-sent events connection">
      <span className={`size-2 rounded-full bg-current ${c === "live" ? "animate-pulse-ring" : ""}`} />
      {c === "live" ? "Live" : c === "connecting" ? "Connecting" : "Reconnecting"}
    </span>
  );
}

/** Thin vertical icon rail on the left (wide screens): the same destinations as the top nav, icon only. */
export function Rail({ route }: { route: RouteId }) {
  return (
    <nav aria-label="Quick navigation" className="glass fixed left-4 top-1/2 z-30 hidden -translate-y-1/2 flex-col items-center gap-2 rounded-full p-2 min-[1280px]:flex">
      {NAV.map((n) => (
        <button
          key={n.id}
          onClick={() => navigate(n.id)}
          aria-label={n.label}
          title={n.label + (n.soon ? " (coming next)" : "")}
          className={`focus-ring grid size-10 place-items-center rounded-full transition duration-[var(--duration-fast)] ${route === n.id ? "bg-lime text-fg shadow-soft" : "text-mute hover:bg-hover hover:text-fg"}`}
        >
          {n.icon}
        </button>
      ))}
    </nav>
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
    <header className="sticky top-0 z-40 px-4 pt-3 sm:px-6">
      <div className="glass mx-auto flex min-h-[68px] max-w-[1800px] flex-wrap items-center gap-x-3 gap-y-2 rounded-[34px] px-3 py-2 pl-5 md:flex-nowrap md:py-0">
        <a href="#/live" className="focus-ring mr-auto shrink-0 rounded-full md:mr-2" aria-label="Purser home">
          <Logo size={34} />
        </a>

        <nav className="order-last flex w-full min-w-0 items-center gap-1 overflow-x-auto pb-1 md:order-none md:w-auto md:flex-1 md:justify-center md:pb-0" aria-label="Primary">
          {NAV.map((n) => {
            const active = route === n.id;
            return (
              <button
                key={n.id}
                onClick={() => navigate(n.id)}
                aria-current={active ? "page" : undefined}
                className={`focus-ring relative flex shrink-0 items-center gap-2 rounded-full border px-4 py-2 text-[13.5px] font-medium transition duration-[var(--duration-fast)] ${active ? "border-lime-line bg-lime text-fg" : "border-transparent text-dim hover:bg-hover hover:text-fg"}`}
              >
                <span className={active ? "text-fg" : "text-mute"}>{n.icon}</span>
                {n.label}
                {n.id === "approvals" && pending > 0 && <span className="num grid min-w-5 place-items-center rounded-full bg-escalate px-1.5 text-[11px] font-semibold leading-5 text-white">{pending}</span>}
                {n.soon && <span className="rounded-full border border-line-strong px-1.5 py-px text-[9px] font-semibold uppercase tracking-wider text-mute">soon</span>}
              </button>
            );
          })}
        </nav>

        <ConnectionPill />
        <RoundButton label="How this works" onClick={onHow} className="hidden lg:grid">
          <IconInfo size={16} />
        </RoundButton>
        <RoundButton label="Sign out" onClick={onLogout}>
          <IconSignOut size={16} />
        </RoundButton>

        <button
          onClick={() => (frozen ? undefined : setConfirm(true))}
          disabled={frozen}
          className={`focus-ring inline-flex h-11 shrink-0 items-center gap-2 rounded-full px-5 text-[13px] font-semibold tracking-wider transition duration-[var(--duration-base)] ease-soft ${frozen ? "cursor-default bg-deny-solid text-white shadow-red" : "bg-ink text-on-ink shadow-pill hover:bg-deny-solid hover:shadow-red active:scale-[0.98]"}`}
          title={frozen ? "Agents are frozen" : "Freeze every agent immediately"}
        >
          <IconSnow size={15} strokeWidth={2.2} />
          <span className="hidden sm:inline">{frozen ? "FROZEN" : "KILL SWITCH"}</span>
        </button>
      </div>

      <Modal open={confirm} onClose={() => setConfirm(false)} title="Freeze all agents" tone="danger">
        <div className="flex items-start gap-4">
          <div className="grid size-12 shrink-0 place-items-center rounded-full bg-deny-soft text-deny">
            <IconSnow size={22} />
          </div>
          <div>
            <h2 className="text-2xl">Freeze every agent now?</h2>
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
