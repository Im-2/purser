import { Suspense, lazy, useMemo, useState } from "react";
import { AgentsPanel } from "../components/AgentsPanel";
import { useDrawer } from "../components/AttemptDrawer";

// AG Grid is the bulk of the bundle: load it only when the Live page is shown.
const AttemptsGrid = lazy(() => import("../components/AttemptsGrid").then((m) => ({ default: m.AttemptsGrid })));
import { StatsStrip } from "../components/StatsStrip";
import { Skeleton } from "../components/ui";
import { isDemo } from "../lib/api";
import { useStore } from "../lib/store";
import type { Decision } from "../lib/types";

const FILTERS: { id: "all" | Decision; label: string; dot: string }[] = [
  { id: "all", label: "All", dot: "bg-dim" },
  { id: "allow", label: "Allowed", dot: "bg-allow" },
  { id: "escalate", label: "Escalated", dot: "bg-escalate" },
  { id: "deny", label: "Denied", dot: "bg-deny" },
];

function GridSkeleton() {
  return (
    <div className="space-y-2 p-4" aria-busy="true" aria-label="Loading attempts">
      {Array.from({ length: 8 }, (_, i) => (
        <Skeleton key={i} className="h-11" />
      ))}
    </div>
  );
}

export function LivePage() {
  const { state } = useStore();
  const drawer = useDrawer();
  const [decision, setDecision] = useState<"all" | Decision>("all");
  const [quick, setQuick] = useState("");

  // reads are not money movements: keep the ledger focused on calls that matter
  const rows = useMemo(() => state.attempts.filter((a) => a.tool_class !== "read"), [state.attempts]);
  const counts = useMemo(() => ({ all: rows.length, allow: rows.filter((r) => r.decision === "allow").length, escalate: rows.filter((r) => r.decision === "escalate").length, deny: rows.filter((r) => r.decision === "deny").length }), [rows]);

  return (
    <main className="mx-auto max-w-[1800px] px-4 py-5 sm:px-6">
      <StatsStrip />

      <div className="mt-4 grid gap-4 min-[1700px]:grid-cols-[minmax(0,1fr)_330px]">
        <section className={`panel flex ${isDemo() ? "h-[calc(100vh-396px)]" : "h-[calc(100vh-352px)]"} min-h-[420px] flex-col overflow-hidden min-[1700px]:h-[calc(100vh-282px)]`} aria-label="Attempts">
          <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
            <div>
              <h1 className="text-[15px] font-medium leading-tight">Live decisions</h1>
              <p className="text-xs text-mute">Purser keeps the books. Click any row to see why.</p>
            </div>
            <div className="ml-auto flex flex-wrap items-center gap-2.5">
              <div role="radiogroup" aria-label="Filter by decision" className="inline-flex rounded-full border border-line-strong bg-sunken p-1">
                {FILTERS.map((f) => (
                  <button
                    key={f.id}
                    role="radio"
                    aria-checked={decision === f.id}
                    onClick={() => setDecision(f.id)}
                    className={`focus-ring flex items-center gap-2 rounded-full px-3.5 py-1.5 text-[12.5px] font-medium transition ${decision === f.id ? "bg-ink text-on-ink shadow-pill" : "text-dim hover:bg-hover hover:text-fg"}`}
                  >
                    <span className={`size-2 rounded-full ${f.dot}`} />
                    {f.label}
                    <span className="num text-[11px] opacity-60">{counts[f.id]}</span>
                  </button>
                ))}
              </div>
              <input
                value={quick}
                onChange={(e) => setQuick(e.target.value)}
                placeholder="Search payee, tool, signal..."
                aria-label="Search attempts"
                className="focus-ring h-10 w-60 rounded-full border border-line-strong bg-sunken px-4 text-[13px] text-fg placeholder:text-mute"
              />
            </div>
          </div>
          <div className="min-h-0 flex-1">
            {!state.ready ? (
              <GridSkeleton />
            ) : (
              <Suspense fallback={<GridSkeleton />}>
                <AttemptsGrid rows={rows} fresh={state.fresh} decision={decision} quick={quick} onOpen={drawer.open} />
              </Suspense>
            )}
          </div>
        </section>

        <aside className="order-first min-[1700px]:order-none">
          <AgentsPanel />
        </aside>
      </div>
    </main>
  );
}
