import { Suspense, lazy, useMemo, useState } from "react";
import { KIND_LABEL, TypeChip, kindOf, type RowKind } from "../components/ReconChips";
import { IconScale } from "../components/icons";
import { Button, Modal, Skeleton } from "../components/ui";
import { ApiError, isDemo, post } from "../lib/api";
import { relTime } from "../lib/format";
import { useStore } from "../lib/store";
import { useToast } from "../lib/toast";
import type { ReconFinding, ReconRun, SearchStatus } from "../lib/types";

const ReconGrid = lazy(() => import("../components/ReconGrid").then((m) => ({ default: m.ReconGrid })));

const FILTERS: RowKind[] = ["matched", "unrecorded_movement", "amount_mismatch", "duplicate", "payout_denied_or_unclaimed"];

const STATUS: Record<SearchStatus, { label: string; cls: string; hint: string }> = {
  ok: { label: "ok", cls: "border-allow-line bg-allow-soft text-allow", hint: "Transaction Search answered and is up to date." },
  lagging: { label: "lagging", cls: "border-escalate-line bg-escalate-soft text-escalate", hint: "Sandbox search trails real time. Batch lookups and webhooks still cover the gap." },
  unavailable: { label: "unavailable", cls: "border-deny-line bg-deny-soft text-deny", hint: "Transaction Search could not be reached. The ledger check still ran." },
  skipped: { label: "skipped", cls: "border-line-strong bg-sunken text-dim", hint: "Transaction Search was not used for this run." },
};

function GridSkeleton() {
  return (
    <div className="space-y-2 p-4" aria-busy="true" aria-label="Loading findings">
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={i} className="h-11" />
      ))}
    </div>
  );
}

function FindingModal({ f, onClose }: { f: ReconFinding | null; onClose: () => void }) {
  return (
    <Modal open={Boolean(f)} onClose={onClose} title="Finding details" wide>
      {f && (
        <div>
          <div className="flex flex-wrap items-center gap-3 pr-10">
            <TypeChip kind={kindOf(f)} />
            <span className="num text-xs text-mute">{new Date(f.ts).toLocaleString()}</span>
          </div>
          <h2 className="mt-3 text-2xl">{String(f.detail.message ?? f.detail.note ?? (f.matched ? "Matches what Purser approved" : "Observed event"))}</h2>
          <dl className="mt-4 grid grid-cols-[130px_1fr] gap-x-4 gap-y-1.5 text-[13px]">
            {[["Event", f.event_type], ["Event id", f.paypal_event_id], ["Ledger row", f.ledger_id]].map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-mute">{k}</dt>
                <dd className="num break-all text-fg">{v ?? "none (PayPal activity Purser has no record of)"}</dd>
              </div>
            ))}
          </dl>
          <div className="eyebrow mb-2 mt-5">Everything PayPal reported</div>
          <pre tabIndex={0} className="focus-ring num max-h-72 overflow-auto rounded-[var(--radius-inner)] border border-line bg-raised p-4 text-[12px] leading-relaxed text-dim">{JSON.stringify(f.detail, null, 2)}</pre>
        </div>
      )}
    </Modal>
  );
}

export function ReconciliationPage() {
  const { state, setReconRun, refreshRecon } = useStore();
  const toast = useToast();
  const demo = isDemo();
  const [kind, setKind] = useState<"all" | RowKind>("all");
  const [running, setRunning] = useState(false);
  const [open, setOpen] = useState<ReconFinding | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const rows = state.recon;
  const counts = useMemo(() => {
    const c: Record<string, number> = { matched: 0, unrecorded_movement: 0, amount_mismatch: 0, duplicate: 0, payout_denied_or_unclaimed: 0 };
    for (const r of rows ?? []) {
      const k = kindOf(r);
      if (k in c) c[k] = (c[k] ?? 0) + 1;
    }
    return c;
  }, [rows]);
  const flagged = Object.entries(counts).reduce((n, [k, v]) => (k === "matched" ? n : n + v), 0);
  const run: ReconRun | null = state.reconRun;

  const runNow = async () => {
    setRunning(true);
    try {
      const r = await post<ReconRun>("/api/reconciliation/run", { lookback_hours: 24 });
      setReconRun(r);
      await refreshRecon();
      const s = r.transaction_search.status;
      toast.push(r.findings.length ? "warn" : "success", r.findings.length ? `${r.findings.length} finding${r.findings.length === 1 ? "" : "s"}` : "Reconciliation clean", `Search ${s}. ${r.ledger.matched} of ${r.ledger.checked} ledger rows matched.`);
      setLoadErr(null);
    } catch (e) {
      const m = e instanceof ApiError ? e.message : (e as Error).message;
      setLoadErr(m);
      toast.push("error", "Reconciliation run failed", m);
    } finally {
      setRunning(false);
    }
  };

  return (
    <main className="mx-auto max-w-[1800px] px-4 py-5 sm:px-6">
      <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-3">
        <div>
          <h1 className="text-2xl">Reconciliation</h1>
          <p className="text-sm text-dim">PayPal&apos;s view against Purser&apos;s ledger. Money that moved without an approval shows up here.</p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          {run && (
            <div className="flex items-center gap-2.5 rounded-full border border-line-strong bg-panel py-1.5 pl-4 pr-1.5 text-[12.5px] text-dim shadow-soft" title={STATUS[run.transaction_search.status].hint}>
              <span className="text-mute">Last run {relTime(run.ran_at)}</span>
              <span>Transaction search</span>
              <span className={`rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider ${STATUS[run.transaction_search.status].cls}`}>{STATUS[run.transaction_search.status].label}</span>
            </div>
          )}
          <Button tone="primary" size="lg" busy={running} disabled={demo} title={demo ? "Run now talks to PayPal, so it needs the admin token" : undefined} onClick={runNow}>
            <IconScale size={15} /> {running ? "Running..." : "Run now"}
          </Button>
        </div>
      </div>

      {run && (
        <div role="status" className="rise mb-4 flex flex-wrap items-center gap-x-6 gap-y-1 rounded-[var(--radius-card)] border border-lime-line bg-lime-soft px-5 py-3 text-[13px] text-dim">
          <span><span className="num text-fg">{run.ledger.matched}</span> of <span className="num text-fg">{run.ledger.checked}</span> ledger rows matched</span>
          <span>{run.transaction_search.note}</span>
          {run.ledger.errors.length > 0 && <span className="text-deny">{run.ledger.errors.length} lookup error{run.ledger.errors.length === 1 ? "" : "s"}</span>}
        </div>
      )}

      <section className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5" aria-label="Finding counts">
        {FILTERS.map((k, i) => {
          const on = kind === k;
          return (
            <button
              key={k}
              onClick={() => setKind(on ? "all" : k)}
              aria-pressed={on}
              style={{ "--i": i } as React.CSSProperties}
              className={`focus-ring rise panel flex items-center justify-between gap-3 px-5 py-4 text-left transition duration-[var(--duration-base)] ease-soft hover:-translate-y-0.5 ${on ? "!border-lime-line !bg-lime-soft" : "hover:bg-hover"}`}
            >
              <div>
                <TypeChip kind={k} />
                <div className="mt-2.5 text-[11px] text-mute">{on ? "showing only these" : "click to filter"}</div>
              </div>
              <span className="num text-[2rem] leading-none text-fg">{counts[k]}</span>
            </button>
          );
        })}
      </section>

      <section className="panel flex h-[calc(100vh-390px)] min-h-[380px] flex-col overflow-hidden" aria-label="Findings">
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3.5">
          <div>
            <h2 className="text-[17px]">Findings</h2>
            <p className="text-xs text-mute">{flagged === 0 ? "Nothing flagged. New findings land here live." : `${flagged} flagged. Click a row for everything PayPal reported.`}</p>
          </div>
          {kind !== "all" && (
            <button onClick={() => setKind("all")} className="focus-ring ml-auto inline-flex items-center gap-2 rounded-full border border-lime-line bg-lime px-3.5 py-1.5 text-[12px] text-accent-hi">
              Showing {KIND_LABEL[kind]} <span aria-hidden="true">×</span>
              <span className="sr-only">clear filter</span>
            </button>
          )}
        </div>
        {loadErr && (
          <p role="alert" className="mx-5 mt-3 rounded-[var(--radius-inner)] border border-deny-line bg-deny-soft px-4 py-2 text-[13px] text-deny">
            {loadErr}
          </p>
        )}
        <div className="min-h-0 flex-1">
          {rows === null ? (
            <GridSkeleton />
          ) : (
            <Suspense fallback={<GridSkeleton />}>
              <ReconGrid rows={rows} fresh={state.reconFresh} kind={kind} onOpen={setOpen} />
            </Suspense>
          )}
        </div>
      </section>

      <FindingModal f={open} onClose={() => setOpen(null)} />
    </main>
  );
}
