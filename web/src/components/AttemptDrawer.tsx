import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { get } from "../lib/api";
import { STAGE_LABEL, clock, label, money, relTime } from "../lib/format";
import { useStore } from "../lib/store";
import type { Attempt, AttemptDetail } from "../lib/types";
import { DecisionChip, RiskMeter, RuleChip, SignalChip, signalId } from "./Chips";
import { IconAlert, IconCheck, IconX } from "./icons";
import { Skeleton } from "./ui";

interface DrawerApi {
  open: (id: string) => void;
  close: () => void;
  selectedId: string | null;
}
const Ctx = createContext<DrawerApi>({ open: () => undefined, close: () => undefined, selectedId: null });
export const useDrawer = () => useContext(Ctx);

export function DrawerProvider({ children }: { children: ReactNode }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const api = useMemo(() => ({ open: setSelectedId, close: () => setSelectedId(null), selectedId }), [selectedId]);
  return (
    <Ctx.Provider value={api}>
      {children}
      <AttemptDrawer />
    </Ctx.Provider>
  );
}

const PIPELINE = ["auth", "killswitch", "classify", "rules", "trust", "ai", "approval", "execute"] as const;

function Pipeline({ a }: { a: AttemptDetail }) {
  const decidedAt = PIPELINE.indexOf(a.decision_stage as (typeof PIPELINE)[number]);
  const tone = a.decision === "allow" ? "text-allow border-allow-line bg-allow-soft" : a.decision === "escalate" ? "text-escalate border-escalate-line bg-escalate-soft" : "text-deny border-deny-line bg-deny-soft";
  return (
    <ol className="flex flex-wrap gap-1.5" aria-label="Pipeline stages">
      {PIPELINE.map((st, i) => {
        const decided = i === decidedAt;
        const passed = i < decidedAt || (a.decision === "allow" && ((st === "ai" && a.ai !== null) || (st === "trust" && a.signals.length > 0) || (st === "execute" && a.ledger !== null)));
        return (
          <li key={st} className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-medium ${decided ? tone : passed ? "border-line-strong bg-raised text-dim" : "border-line text-mute/60"}`}>
            {decided ? (a.decision === "allow" ? <IconCheck size={12} strokeWidth={2.6} /> : a.decision === "deny" ? <IconX size={12} strokeWidth={2.6} /> : <IconAlert size={12} strokeWidth={2.4} />) : passed ? <IconCheck size={11} strokeWidth={2.4} /> : null}
            {STAGE_LABEL[st]}
          </li>
        );
      })}
    </ol>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-line px-6 py-5">
      <h3 className="eyebrow mb-3">{title}</h3>
      {children}
    </section>
  );
}

function Quote({ children }: { children: ReactNode }) {
  return <blockquote className="rounded-2xl border-l-2 border-lime-line bg-lime-soft px-3.5 py-2.5 text-[13.5px] leading-relaxed text-fg/90">{children}</blockquote>;
}

function Json({ value }: { value: unknown }) {
  const text = useMemo(() => {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }, [value]);
  return <pre className="num max-h-64 overflow-auto rounded-2xl border border-line bg-sunken p-3 text-[12px] leading-relaxed text-dim">{text}</pre>;
}

function Body({ a }: { a: AttemptDetail }) {
  const hasArgs = Object.keys(a.args ?? {}).length > 0;
  const signals = a.signals_detail;
  return (
    <>
      <div className="px-6 pb-5 pt-1">
        <div className="flex flex-wrap items-center gap-2.5">
          <DecisionChip decision={a.decision} size="lg" />
          <span className="num text-sm text-dim">{a.tool}</span>
          {a.ai?.advisory && <span className="rounded-full border border-line-strong px-2 py-0.5 text-[11px] text-dim">AI advisory: a human decides</span>}
        </div>
        <div className="mt-4 flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <span className="num text-[2rem] font-medium leading-none">{a.amount === null ? "amount unknown" : money(a.amount, a.currency)}</span>
          {a.payee_email && <span className="num text-sm text-dim">to {a.payee_email}</span>}
        </div>
        <div className="num mt-2 text-xs text-mute">
          {clock(a.ts)} · {relTime(a.ts)} · {a.latency_ms ?? "?"} ms · <span title={a.id}>{a.id}</span>
        </div>
      </div>

      <Section title="Decided at">
        <Pipeline a={a} />
        <p className="mt-2.5 text-[13px] text-dim">
          {a.decision === "allow" ? `Allowed. Every stage up to ${label(STAGE_LABEL, a.decision_stage).toLowerCase()} passed.` : `${a.decision === "deny" ? "Denied" : "Escalated"} by ${label(STAGE_LABEL, a.decision_stage).toLowerCase()}.`}
        </p>
      </Section>

      <Section title={`Rules hit (${a.rule_hits_detail.length})`}>
        {a.rule_hits_detail.length === 0 ? (
          <p className="text-[13px] text-dim">No rule objected to this call.</p>
        ) : (
          <ul className="space-y-2">
            {a.rule_hits_detail.map((h, i) => (
              <li key={`${h.id}-${i}`} className="flex items-start gap-2.5">
                <RuleChip id={h.id} severity={h.severity} />
                <span className="pt-0.5 text-[13px] leading-snug text-dim">{h.message ?? ""}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={`Trust signals (${signals.length})`}>
        {signals.length === 0 ? (
          <p className="text-[13px] text-dim">No payee signals. Trust checks apply to payouts to a payee.</p>
        ) : (
          <ul className="space-y-2.5">
            {signals.map((s, i) => (
              <li key={`${signalId(s)}-${i}`} className="grid gap-1">
                <div>
                  <SignalChip id={signalId(s)} severity={typeof s === "string" ? undefined : s.severity} />
                </div>
                {typeof s !== "string" && s.evidence && <div className="pl-0.5 text-[13px] leading-snug text-dim">{s.evidence}</div>}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="AI reviewer">
        {!a.ai ? (
          <p className="text-[13px] text-dim">The reviewer did not run for this call (reads, and calls the rules already denied, skip it).</p>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <DecisionChip decision={a.ai.verdict} />
              <RiskMeter risk={a.ai.risk} />
              {a.ai.cached && <span className="rounded-full border border-line-strong px-1.5 py-px text-[10.5px] font-semibold uppercase tracking-wide text-dim">cached</span>}
              {a.ai.stale && <span className="rounded-full border border-escalate-line px-1.5 py-px text-[10.5px] font-semibold uppercase tracking-wide text-escalate">stale</span>}
              {a.ai.error && <span className="rounded-full border border-deny-line px-1.5 py-px text-[10.5px] font-semibold uppercase tracking-wide text-deny">fail-closed: {a.ai.error}</span>}
            </div>
            <Quote>{a.ai.rationale}</Quote>
            {a.ai.flags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {a.ai.flags.map((f) => (
                  <span key={f} className="rounded-full border border-line-strong bg-raised px-2 py-0.5 text-[11px] text-dim">{f}</span>
                ))}
              </div>
            )}
            <div className="num text-[11px] text-mute">{a.ai.model ?? "model"}{a.ai.latency_ms ? ` · ${a.ai.latency_ms} ms` : ""}</div>
          </div>
        )}
      </Section>

      <Section title="What the agent said">
        <div className="space-y-3">
          <div>
            <div className="mb-1 text-xs text-mute">Reason</div>
            {a.reason ? <Quote>{a.reason}</Quote> : <p className="text-[13px] text-dim">None given.</p>}
          </div>
          <div>
            <div className="mb-1 text-xs text-mute">Source of the instruction</div>
            {a.source ? <Quote>{a.source}</Quote> : <p className="text-[13px] text-dim">None given.</p>}
          </div>
        </div>
      </Section>

      {hasArgs && (
        <Section title="Arguments">
          <Json value={a.args} />
        </Section>
      )}

      <Section title="Outcome">
        <div className="space-y-3 text-[13px]">
          {a.approval && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-mute">Approval</span>
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${a.approval.status === "approved" ? "bg-allow-soft text-allow" : a.approval.status === "pending" ? "bg-escalate-soft text-escalate" : "bg-deny-soft text-deny"}`}>{a.approval.status}</span>
              {a.approval.decided_by && <span className="text-dim">by {a.approval.decided_by}</span>}
            </div>
          )}
          {a.ledger ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-mute">Ledger</span>
              <span className="num text-fg">{a.ledger.id}</span>
              <span className="rounded-full bg-allow-soft px-2 py-0.5 text-[11px] font-semibold text-allow">{a.ledger.status}</span>
              {typeof a.ledger.paypal_ref?.payout_batch_id === "string" && <span className="num text-dim">batch {a.ledger.paypal_ref.payout_batch_id}</span>}
            </div>
          ) : (
            <div className="text-dim">{a.decision === "allow" ? "No ledger row (a read, or the call has not executed)." : "Nothing executed. No money moved."}</div>
          )}
          {a.upstream_result != null && <Json value={a.upstream_result} />}
        </div>
      </Section>
    </>
  );
}

function AttemptDrawer() {
  const { selectedId, close } = useDrawer();
  const { state } = useStore();
  const [detail, setDetail] = useState<AttemptDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  // refetch when this attempt changes (execution finished, a human decided) so the drawer never shows stale state
  const live: Attempt | undefined = selectedId ? state.attempts.find((x) => x.id === selectedId) : undefined;
  const version = live ? `${live.decision}|${live.decision_stage}|${live.ledger_id ?? ""}|${live.approval_id ?? ""}` : "";

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setError(null);
      return;
    }
    let alive = true;
    setError(null);
    get<AttemptDetail>(`/api/attempts/${selectedId}`)
      .then((d) => alive && setDetail(d))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [selectedId, version]);

  useEffect(() => {
    if (!selectedId) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, close]);

  const open = selectedId !== null;
  return (
    <div className={`fixed inset-0 z-50 ${open ? "" : "pointer-events-none"}`} aria-hidden={!open}>
      <div onClick={close} className={`absolute inset-0 bg-ink/25 backdrop-blur-sm transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0"}`} />
      <aside role="dialog" aria-label="Attempt details" className={`absolute inset-y-0 right-0 flex w-[min(560px,100vw)] flex-col border-l border-line-strong bg-panel ${open ? "shadow-drawer" : ""} rounded-l-[var(--radius-panel)] transition-transform duration-250 ease-out ${open ? "translate-x-0" : "translate-x-full"}`}>
        <div className="flex items-center justify-between px-6 py-4">
          <h2 className="eyebrow">Why Purser decided this</h2>
          <button onClick={close} className="focus-ring grid size-8 place-items-center rounded-2xl text-dim hover:bg-hover hover:text-fg" aria-label="Close details">
            <IconX size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pb-8">
          {error && <p className="px-6 py-6 text-sm text-deny">Could not load this attempt: {error}</p>}
          {!error && !detail && open && (
            <div className="space-y-4 px-6 py-4">
              <Skeleton className="h-8 w-56" />
              <Skeleton className="h-10 w-72" />
              <Skeleton className="h-24" />
              <Skeleton className="h-32" />
            </div>
          )}
          {detail && <Body a={detail} />}
        </div>
      </aside>
    </div>
  );
}
