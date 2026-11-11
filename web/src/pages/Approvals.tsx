import { useState } from "react";
import { useDrawer } from "../components/AttemptDrawer";
import { DecisionChip, RiskMeter, SignalChip, signalId } from "../components/Chips";
import { IconCheck, IconClock, IconShield, IconX } from "../components/icons";
import { Button, EmptyState, Skeleton } from "../components/ui";
import { useActions } from "../lib/actions";
import { clock, countdown, money, relTime } from "../lib/format";
import { navigate } from "../lib/route";
import { useStore } from "../lib/store";
import type { ApprovalItem } from "../lib/types";
import { useNow } from "../lib/useNow";

function Quote({ k, children }: { k: string; children: string | null }) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-mute">{k}</div>
      <p className="rounded-2xl border-l-2 border-lime-line bg-lime-soft px-3.5 py-2.5 text-[14px] leading-relaxed text-fg/90">{children ?? <span className="text-mute">None given</span>}</p>
    </div>
  );
}

function PendingCard({ ap }: { ap: ApprovalItem }) {
  const actions = useActions();
  const drawer = useDrawer();
  const now = useNow(1000);
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const a = ap.attempt;
  const left = Date.parse(ap.expires_at) - now;
  const urgent = left < 120_000;
  const lookalike = a?.signals_detail.some((s) => signalId(s) === "lookalike_payee");

  const act = async (kind: "approve" | "deny") => {
    setBusy(kind);
    await (kind === "approve" ? actions.approve(ap.approval_id) : actions.deny(ap.approval_id));
    setBusy(null);
  };

  return (
    <article className={`panel rise overflow-hidden ${lookalike ? "border-escalate-line" : ""}`} aria-label={`Approval ${ap.approval_id}`}>
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-line px-5 py-4 sm:px-6">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <DecisionChip decision="escalate" />
            <span className="num text-[13px] text-dim">{a?.tool ?? "tool call"}</span>
          </div>
          <div className="num mt-3 text-[2.4rem] font-medium leading-none">{a ? (a.amount === null ? "amount unknown" : money(a.amount, a.currency)) : "..."}</div>
          <div className="num mt-2 break-all text-[15px] text-fg">{a?.payee_email ?? "no payee"}</div>
        </div>
        <div className={`rounded-[22px] border px-4 py-3 text-right ${urgent ? "border-deny-line bg-deny-soft" : "border-line-strong bg-raised/60"}`}>
          <div className="eyebrow flex items-center justify-end gap-1.5"><IconClock size={12} /> expires in</div>
          <div className={`num mt-1 text-[1.75rem] font-medium leading-none ${urgent ? "text-deny" : "text-fg"}`}>{countdown(left)}</div>
        </div>
      </div>

      <div className="grid gap-5 px-5 py-5 sm:px-6 lg:grid-cols-2">
        <div className="space-y-4">
          <Quote k="Why the agent says it is paying">{a?.reason ?? null}</Quote>
          <Quote k="Where the instruction came from">{a?.source ?? null}</Quote>
        </div>
        <div className="space-y-4">
          <div>
            <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-mute">Purser flagged</div>
            {a && a.signals_detail.length > 0 ? (
              <ul className="space-y-2">
                {a.signals_detail.map((s, i) => (
                  <li key={`${signalId(s)}-${i}`}>
                    <SignalChip id={signalId(s)} severity={typeof s === "string" ? undefined : s.severity} />
                    {typeof s !== "string" && s.evidence && <div className="mt-1 text-[12.5px] leading-snug text-dim">{s.evidence}</div>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-dim">No payee signals. {a?.rule_hits_detail[0]?.message ?? "Held by policy."}</p>
            )}
          </div>
          {a?.ai && (
            <div>
              <div className="mb-2 flex items-center gap-3 text-[11px] font-medium uppercase tracking-wider text-mute">
                AI reviewer <RiskMeter risk={a.ai.risk} />
              </div>
              <p className="text-[13.5px] leading-relaxed text-dim">{a.ai.rationale}</p>
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-line bg-sunken/50 px-5 py-4 sm:px-6">
        <Button tone="allow" size="lg" busy={busy === "approve"} disabled={busy !== null || left <= 0} onClick={() => act("approve")} className="min-w-40 flex-1 sm:flex-none">
          <IconCheck size={18} strokeWidth={2.6} /> Approve
        </Button>
        <Button tone="deny" size="lg" busy={busy === "deny"} disabled={busy !== null || left <= 0} onClick={() => act("deny")} className="min-w-40 flex-1 sm:flex-none">
          <IconX size={18} strokeWidth={2.6} /> Deny
        </Button>
        <button onClick={() => a && drawer.open(a.id)} className="focus-ring ml-auto rounded-2xl px-3 py-2 text-[13px] font-medium text-dim transition hover:bg-hover hover:text-fg">
          Full explanation
        </button>
      </div>
      {lookalike && (
        <div className="border-t border-escalate-line bg-escalate-soft px-6 py-2.5 text-[12.5px] text-escalate">
          The payee address closely resembles a known vendor's. Approving sends real money to it.
        </div>
      )}
    </article>
  );
}

const STATUS_TONE = { approved: "text-allow bg-allow-soft", denied: "text-deny bg-deny-soft", expired: "text-dim bg-raised", pending: "text-escalate bg-escalate-soft" } as const;

function ResolvedRow({ ap }: { ap: ApprovalItem }) {
  const drawer = useDrawer();
  const a = ap.attempt;
  return (
    <li>
      <button onClick={() => a && drawer.open(a.id)} className="focus-ring grid w-full grid-cols-[96px_1fr_auto] items-center gap-4 rounded-[22px] border border-transparent px-4 py-3 text-left transition hover:border-line hover:bg-raised/60 sm:grid-cols-[96px_130px_1fr_auto]">
        <span className={`w-fit rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${STATUS_TONE[ap.status]}`}>{ap.status}</span>
        <span className="num hidden text-[14px] font-medium sm:block">{a ? money(a.amount, a.currency) : ""}</span>
        <span className="num min-w-0 truncate text-[13px] text-dim">{a?.payee_email ?? ""}</span>
        <span className="num text-right text-[12px] text-mute">
          {ap.decided_at ? `${clock(ap.decided_at)} · ${relTime(ap.decided_at)}` : relTime(ap.expires_at)}
          {ap.status === "approved" && ap.result?.executed && <span className="ml-2 text-allow">paid{ap.result.payout_batch_id ? ` · ${ap.result.payout_batch_id}` : ""}</span>}
        </span>
      </button>
    </li>
  );
}

export function ApprovalsPage() {
  const { state } = useStore();
  const pending = state.approvals.filter((a) => a.status === "pending");
  const resolved = state.approvals.filter((a) => a.status !== "pending").sort((x, y) => Date.parse(y.decided_at ?? y.expires_at) - Date.parse(x.decided_at ?? x.expires_at));

  return (
    <main className="mx-auto max-w-[1200px] px-4 py-6 sm:px-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-medium tracking-tight">Approvals</h1>
          <p className="mt-1 text-sm text-dim">Calls Purser would not decide alone. Approving executes the stored call exactly once.</p>
        </div>
        <span className="num rounded-full border border-line-strong px-3 py-1 text-xs text-dim">{pending.length} pending</span>
      </div>

      {!state.ready ? (
        <div className="space-y-4">
          <Skeleton className="h-72 rounded-2xl" />
        </div>
      ) : pending.length === 0 ? (
        <div className="panel">
          <EmptyState
            icon={<IconShield size={24} />}
            title="Nothing is waiting on you"
            action={
              <Button tone="primary" onClick={() => navigate("lab")}>
                Trigger one from the Attack Lab
              </Button>
            }
          >
            When an agent tries something risky, like paying an address that looks a lot like a vendor's, it lands here with everything you need to decide.
          </EmptyState>
        </div>
      ) : (
        <div className="space-y-5">
          {pending.map((ap) => (
            <PendingCard key={ap.approval_id} ap={ap} />
          ))}
        </div>
      )}

      {resolved.length > 0 && (
        <section className="mt-10" aria-label="Resolved approvals">
          <h2 className="eyebrow mb-3 px-1">Resolved</h2>
          <ul className="panel divide-y divide-line/60 p-1.5">
            {resolved.map((ap) => (
              <ResolvedRow key={ap.approval_id} ap={ap} />
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
