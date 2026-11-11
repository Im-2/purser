import { useCallback, useEffect, useMemo, useState } from "react";
import { EmptyState, Button, Segmented, Skeleton } from "../components/ui";
import { IconAlert, IconCheck, IconSliders } from "../components/icons";
import { ApiError, get, post } from "../lib/api";
import { relTime } from "../lib/format";
import { useStore } from "../lib/store";
import { useToast } from "../lib/toast";
import type { CompileResult, PolicyDiffEntry, PolicyDoc, PolicyState } from "../lib/types";

const SAMPLE = "Allow up to $50 a day on office supplies, refunds up to $30, never pay new vendors without asking";
const EXAMPLES = [
  SAMPLE,
  "Never pay more than $100 in one payment, and ask me before anything over $75",
  "Only pay vendors on the allowlist; block everything else",
];

const MONEY_PATHS = /^(limits\.|approval_threshold$|ai_review\.min_amount$)/;
const fmt = (path: string, v: unknown): string => {
  if (v === undefined) return "not set";
  if (typeof v === "number" && MONEY_PATHS.test(path)) return `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  if (Array.isArray(v)) return v.length ? v.join(", ") : "empty";
  if (v && typeof v === "object") return JSON.stringify(v);
  return String(v);
};

const CHANGE_CHIP: Record<PolicyDiffEntry["change"], { label: string; cls: string }> = {
  added: { label: "added", cls: "border-line-strong bg-sunken text-fg" },
  changed: { label: "changed", cls: "border-lime-line bg-lime text-accent-hi" },
  removed: { label: "removed", cls: "border-line-strong bg-sunken text-dim line-through" },
};

function DiffTable({ diff }: { diff: PolicyDiffEntry[] }) {
  if (diff.length === 0) return <p className="rounded-[var(--radius-inner)] bg-raised px-4 py-3 text-sm text-dim">No field changes. The proposal matches the active policy.</p>;
  return (
    <div className="overflow-hidden rounded-[var(--radius-inner)] border border-line">
      <table className="w-full text-left text-[13px]">
        <thead className="bg-raised text-[11px] uppercase tracking-wider text-mute">
          <tr>
            <th className="px-4 py-2.5 font-medium">Field</th>
            <th className="px-2 py-2.5 font-medium">Change</th>
            <th className="px-4 py-2.5 font-medium">Before</th>
            <th className="px-4 py-2.5 font-medium">After</th>
          </tr>
        </thead>
        <tbody>
          {diff.map((d) => (
            <tr key={d.path} className="border-t border-line align-top">
              <td className="num px-4 py-2.5 text-[12px] text-fg">{d.path}</td>
              <td className="px-2 py-2.5">
                <span className={`inline-flex rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${CHANGE_CHIP[d.change].cls}`}>{CHANGE_CHIP[d.change].label}</span>
              </td>
              <td className="num px-4 py-2.5 text-[12px] text-mute">{d.change === "added" ? "-" : fmt(d.path, d.before)}</td>
              <td className="num break-words px-4 py-2.5 text-[12px] font-medium text-fg">{d.change === "removed" ? "-" : fmt(d.path, d.after)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function JsonView({ doc, label }: { doc: PolicyDoc | null; label: string }) {
  const [copied, setCopied] = useState(false);
  const text = useMemo(() => (doc ? JSON.stringify(doc, null, 2) : ""), [doc]);
  if (!doc) return <p className="px-1 py-6 text-center text-sm text-mute">Nothing to show yet.</p>;
  return (
    <div className="relative">
      <button
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          });
        }}
        className="focus-ring absolute right-3 top-3 rounded-full border border-line-strong bg-panel px-3 py-1 text-[11px] font-medium text-dim transition hover:bg-hover hover:text-fg"
      >
        {copied ? "Copied" : "Copy"}
      </button>
      <pre aria-label={label} tabIndex={0} className="focus-ring num max-h-[360px] overflow-auto rounded-[var(--radius-inner)] border border-line bg-raised p-4 pr-16 text-[12px] leading-relaxed text-dim">
        {text}
      </pre>
    </div>
  );
}

function Stat({ k, v, text }: { k: string; v: string; text?: boolean }) {
  return (
    <div className="rounded-[var(--radius-inner)] bg-raised px-3.5 py-2.5">
      <div className="text-[11px] text-mute">{k}</div>
      <div className={`mt-0.5 text-fg ${text ? "text-[14px] capitalize" : "num text-[15px]"}`}>{v}</div>
    </div>
  );
}

const money = (n: unknown) => (typeof n === "number" ? `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "n/a");

export function PoliciesPage() {
  const { state } = useStore();
  const toast = useToast();
  const agents = state.agents;
  const [agentId, setAgentId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [policy, setPolicy] = useState<PolicyState | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [applying, setApplying] = useState(false);
  const [proposal, setProposal] = useState<(CompileResult & { source: string }) | null>(null);
  const [applied, setApplied] = useState<{ version: number } | null>(null);
  const [jsonTab, setJsonTab] = useState<"active" | "proposal">("active");
  const [compileErr, setCompileErr] = useState<string | null>(null);

  const agent = agentId ?? agents[0]?.id ?? null;

  const load = useCallback(async () => {
    if (!agent) return;
    try {
      setPolicy(await get<PolicyState>(`/api/policies/${agent}`));
      setLoadErr(null);
    } catch (e) {
      const m = e instanceof ApiError ? e.message : (e as Error).message;
      setLoadErr(m);
      toast.push("error", "Could not load the policy", m);
    }
  }, [agent, toast]);

  // reload on mount, when the agent changes, and after any full refresh (for example a demo reset)
  useEffect(() => {
    void load();
  }, [load, state.tick]);

  // a demo reset or another operator may have changed the active version: drop a stale applied badge
  const activeVersion = (policy?.active?.version as number | undefined) ?? null;
  useEffect(() => {
    if (applied && activeVersion !== null && activeVersion !== applied.version) setApplied(null);
  }, [activeVersion, applied]);

  const compile = async () => {
    if (!agent || !text.trim()) return;
    setCompiling(true);
    setCompileErr(null);
    setApplied(null);
    try {
      const r = await post<CompileResult>("/api/policies/compile", { agent_id: agent, text: text.trim() });
      setProposal({ ...r, source: text.trim() });
      setJsonTab("proposal");
      toast.push("info", "Proposal ready", "Review the changes. Nothing is applied until you press Apply.");
    } catch (e) {
      const m = e instanceof ApiError ? e.message : (e as Error).message;
      setCompileErr(m);
      toast.push("error", "Could not compile", m);
    } finally {
      setCompiling(false);
    }
  };

  const apply = async () => {
    if (!agent || !proposal) return;
    setApplying(true);
    try {
      const r = await post<{ version: number; active: boolean }>("/api/policies/apply", { agent_id: agent, policy: proposal.policy, source_text: proposal.source });
      await load(); // refresh first, so the "applied" badge is only shown once the active version really matches
      setApplied({ version: r.version });
      toast.push("success", `Policy v${r.version} applied`, "It is active now. Reset the demo to restore the seeded policy.");
      setJsonTab("active");
    } catch (e) {
      const m = e instanceof ApiError ? e.message : (e as Error).message;
      toast.push("error", "Could not apply the policy", m);
    } finally {
      setApplying(false);
    }
  };

  const active = policy?.active ?? null;
  const limits = (active?.limits ?? {}) as Record<string, number>;
  const payees = (active?.payees ?? {}) as { mode?: string; allowlist?: string[] };
  const warnings = proposal?.warnings ?? [];
  const isApplied = Boolean(proposal && applied);

  return (
    <main className="mx-auto max-w-[1800px] px-4 py-5 sm:px-6">
      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div>
          <h1 className="text-2xl">Policies</h1>
          <p className="text-sm text-dim">Write the rules in plain English, review exactly what changes, then apply them.</p>
        </div>
        {agents.length > 1 && (
          <div className="ml-auto">
            <Segmented label="Agent" value={agent ?? ""} onChange={(v) => { setAgentId(v); setProposal(null); setApplied(null); }} options={agents.map((a) => ({ value: a.id, label: a.name }))} />
          </div>
        )}
      </div>

      {agents.length === 0 && state.ready ? (
        <section className="panel">
          <EmptyState icon={<IconSliders size={26} />} title="No agents yet">Create or seed an agent first, then its policy appears here.</EmptyState>
        </section>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
          <div className="space-y-4">
            <section className="panel rise p-6" aria-label="Compose a policy" style={{ "--i": 0 } as React.CSSProperties}>
              <label htmlFor="policy-text" className="eyebrow">Describe the rule</label>
              <textarea
                id="policy-text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                maxLength={2000}
                rows={4}
                placeholder={SAMPLE}
                className="focus-ring mt-2 w-full resize-y rounded-[var(--radius-inner)] border border-line-strong bg-sunken px-4 py-3 text-[15px] leading-relaxed text-fg placeholder:text-mute"
              />
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="text-[12px] text-mute">Try:</span>
                {EXAMPLES.map((ex) => (
                  <button key={ex} onClick={() => setText(ex)} className="focus-ring max-w-[320px] truncate rounded-full border border-line-strong bg-panel px-3 py-1 text-[12px] text-dim transition hover:border-lime-line hover:bg-hover hover:text-fg" title={ex}>
                    {ex}
                  </button>
                ))}
              </div>
              <div className="mt-4 flex items-center gap-3">
                <Button tone="primary" size="lg" busy={compiling} disabled={!text.trim() || !agent} onClick={compile}>
                  Compile
                </Button>
                <span className="text-[12.5px] text-mute">Compiling only proposes a policy. It never changes what is live.</span>
                <span className="num ml-auto text-[11px] text-mute">{text.length}/2000</span>
              </div>
              {compileErr && (
                <p role="alert" className="mt-3 rounded-[var(--radius-inner)] border border-deny-line bg-deny-soft px-4 py-2.5 text-[13px] text-deny">
                  {compileErr}
                </p>
              )}
            </section>

            <section className={`${isApplied ? "panel" : "panel-lime"} p-6`} aria-label="Preview" aria-live="polite">
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-xl">Preview</h2>
                {proposal &&
                  (isApplied ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-allow-line bg-allow-soft px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-allow">
                      <IconCheck size={12} strokeWidth={2.6} /> Applied as v{applied?.version}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-ink/50 bg-panel px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-ink">
                      <span className="size-1.5 animate-pulse-ring rounded-full bg-ink" /> Proposal, not applied
                    </span>
                  ))}
                {proposal && <span className="num ml-auto text-[11px] text-mute">{proposal.model} · {proposal.latency_ms} ms</span>}
              </div>

              {!proposal ? (
                <p className="mt-3 text-sm leading-relaxed text-dim">Compile a sentence and the proposed policy appears here with a field-by-field diff and any warnings. It stays a proposal until you press Apply.</p>
              ) : (
                <div className="mt-4 space-y-4">
                  <p className="rounded-[var(--radius-inner)] bg-panel/80 px-4 py-3 text-[14px] leading-relaxed text-fg">&ldquo;{proposal.source}&rdquo;</p>

                  {warnings.length > 0 && (
                    <div>
                      <div className="eyebrow mb-2">Warnings</div>
                      <ul className="space-y-2">
                        {warnings.map((w) => (
                          <li key={w.code + w.message} className="flex items-start gap-2.5">
                            <span className={`mt-px inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${w.level === "warning" ? "border-escalate-line bg-escalate-soft text-escalate" : "border-line-strong bg-sunken text-dim"}`}>
                              <IconAlert size={11} strokeWidth={2.4} />
                              {w.code.replace(/_/g, " ")}
                            </span>
                            <span className="text-[13px] leading-snug text-dim">{w.message}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {proposal.unsupported.length > 0 && (
                    <div>
                      <div className="eyebrow mb-2">Not supported, ignored</div>
                      <div className="flex flex-wrap gap-2">
                        {proposal.unsupported.map((u) => (
                          <span key={u} className="rounded-full border border-line-strong bg-sunken px-3 py-1 text-[12px] text-dim">{u}</span>
                        ))}
                      </div>
                    </div>
                  )}

                  <div>
                    <div className="eyebrow mb-2">What changes ({proposal.diff.length})</div>
                    <DiffTable diff={proposal.diff} />
                  </div>

                  <div className="flex flex-wrap items-center gap-3 pt-1">
                    <Button tone="primary" size="lg" busy={applying} disabled={isApplied} onClick={apply}>
                      {isApplied ? "Applied" : "Apply policy"}
                    </Button>
                    {!isApplied && (
                      <Button onClick={() => { setProposal(null); setCompileErr(null); setJsonTab("active"); }}>Discard</Button>
                    )}
                    <span className="text-[12.5px] text-mute">{isApplied ? "This version is live. The Attack Lab reset restores the seeded policy." : "Nothing changes until you press Apply."}</span>
                  </div>
                </div>
              )}
            </section>
          </div>

          <div className="space-y-4">
            <section className="panel rise p-6" aria-label="Active policy" style={{ "--i": 1 } as React.CSSProperties}>
              <div className="flex items-center gap-3">
                <h2 className="text-xl">Active policy</h2>
                {active && <span className="num rounded-full border border-lime-line bg-lime px-2.5 py-0.5 text-[11px] text-accent-hi">v{String(active.version)}</span>}
              </div>
              {!policy && !loadErr && <div className="mt-4 space-y-2"><Skeleton className="h-16" /><Skeleton className="h-16" /></div>}
              {loadErr && !policy && <p role="alert" className="mt-3 text-sm text-deny">{loadErr} <button className="focus-ring ml-1 rounded-full underline underline-offset-2" onClick={() => void load()}>Retry</button></p>}
              {active && (
                <>
                  {typeof active.mandate === "string" && <p className="mt-2 text-[13px] leading-snug text-dim">{active.mandate}</p>}
                  <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                    <Stat k="Per payment" v={money(limits.per_tx_cap)} />
                    <Stat k="Per day" v={money(limits.daily_cap)} />
                    <Stat k="Per week" v={money(limits.weekly_cap)} />
                    <Stat k="Ask me above" v={money(active.approval_threshold)} />
                    <Stat text k="New payees" v={(payees.mode ?? "n/a").replace(/_/g, " ")} />
                    <Stat k="Allowlist" v={`${payees.allowlist?.length ?? 0} payee${(payees.allowlist?.length ?? 0) === 1 ? "" : "s"}`} />
                  </div>
                </>
              )}
            </section>

            <section className="panel p-6" aria-label="Version history">
              <div className="flex items-baseline gap-3">
                <h2 className="text-xl">Version history</h2>
                {policy && <span className="num text-xs text-mute">{policy.history.length} versions</span>}
              </div>
              {!policy ? (
                <div className="mt-4"><Skeleton className="h-14" /></div>
              ) : policy.history.length === 0 ? (
                <EmptyState icon={<IconSliders size={22} />} title="No versions yet">Applied policies are listed here, newest first.</EmptyState>
              ) : (
                <ol className="mt-3 max-h-[340px] divide-y divide-line overflow-y-auto pr-1" tabIndex={0} aria-label="Versions, newest first">
                  {policy.history.map((h) => (
                    <li key={h.id} className={`flex items-start gap-3 rounded-[var(--radius-inner)] px-2 py-3 ${h.active ? "bg-lime-soft" : ""}`}>
                      <span className={`num mt-0.5 grid size-9 shrink-0 place-items-center rounded-full border text-[12px] ${h.active ? "border-lime-line bg-lime text-accent-hi" : "border-line-strong bg-sunken text-dim"}`}>v{h.version}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          {h.active && <span className="rounded-full border border-allow-line bg-allow-soft px-2 py-px text-[10px] font-semibold uppercase tracking-wider text-allow">active</span>}
                          <span className="text-[12px] text-mute">{relTime(h.created_at)}</span>
                        </div>
                        <p className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-dim" title={h.source_text ?? undefined}>{h.source_text ? h.source_text : <span className="text-mute">Seeded default (no source text)</span>}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <section className="panel p-6" aria-label="Raw JSON">
              <div className="mb-3 flex items-center gap-3">
                <h2 className="text-xl">Raw JSON</h2>
                <div className="ml-auto">
                  <Segmented label="JSON source" value={jsonTab} onChange={setJsonTab} options={[{ value: "active", label: "Active" }, { value: "proposal", label: "Proposal", disabled: !proposal }]} />
                </div>
              </div>
              <JsonView doc={jsonTab === "proposal" ? (proposal?.policy ?? null) : (active as PolicyDoc | null)} label={jsonTab === "proposal" ? "Proposed policy JSON" : "Active policy JSON"} />
            </section>
          </div>
        </div>
      )}
    </main>
  );
}
