import { useState } from "react";
import { useActions } from "../lib/actions";
import { useStore } from "../lib/store";
import { IconSnow } from "./icons";
import { Button } from "./ui";

/** Persistent red banner while anything is frozen. The reason is explicit: operator, global kill switch, or the circuit breaker. */
export function FrozenBanner() {
  const { state } = useStore();
  const actions = useActions();
  const [busy, setBusy] = useState(false);
  const frozen = state.agents.filter((a) => a.effective_status === "frozen");
  if (!state.globalFreeze && frozen.length === 0) return null;

  const breaker = frozen.find((a) => a.freeze?.reason === "circuit_breaker");
  const all = state.globalFreeze || (frozen.length > 0 && frozen.length === state.agents.length);
  const title = all ? "All agents are frozen" : `${frozen.map((a) => a.name).join(", ")} ${frozen.length > 1 ? "are" : "is"} frozen`;
  const detail = breaker?.freeze?.detail as { denies?: number; max_denies?: number; window_sec?: number } | undefined;
  const why = breaker
    ? `The circuit breaker tripped: ${detail?.denies ?? "several"} denied calls within ${detail?.window_sec ?? "a few"} seconds.`
    : state.globalFreeze || frozen.some((a) => a.freeze?.reason === "freeze_all")
      ? "The kill switch was pressed."
      : "An operator froze it.";

  return (
    <div role="alert" className="border-b border-deny/50 bg-[linear-gradient(90deg,rgb(255_93_108/0.22),rgb(255_93_108/0.1))]">
      <div className="mx-auto flex max-w-[1800px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
        <span className="grid size-8 place-items-center rounded-lg bg-deny text-base"><IconSnow size={17} strokeWidth={2.4} /></span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold text-deny">{title}</div>
          <div className="text-[13px] text-fg/80">{why} Every tool call is denied until you unfreeze.</div>
        </div>
        <Button
          tone="deny"
          size="sm"
          busy={busy}
          onClick={async () => {
            setBusy(true);
            await actions.unfreezeAll();
            setBusy(false);
          }}
        >
          Unfreeze
        </Button>
      </div>
    </div>
  );
}
