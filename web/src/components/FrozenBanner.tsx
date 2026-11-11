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
    <div role="alert" className="rise mx-auto max-w-[1800px] px-4 pt-3 sm:px-6">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-panel border border-deny-line bg-deny-soft px-5 py-3 shadow-soft">
        <span className="grid size-9 place-items-center rounded-full bg-deny-solid text-white shadow-red"><IconSnow size={17} strokeWidth={2.4} /></span>
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-medium text-deny">{title}</div>
          <div className="text-[13px] text-dim">{why} Every tool call is denied until you unfreeze.</div>
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
