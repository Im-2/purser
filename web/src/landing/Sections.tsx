import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { LogoMark } from "../components/Logo";
import { IconAlert, IconReset, IconSliders, IconX } from "../components/icons";
import facts from "./facts.json";
import { useCountUp } from "./hooks";

const sty = (i: number) => ({ "--i": i }) as CSSProperties;

/* ------------------------------------------------------------------ 3. problem strip */
const PROBLEMS = [
  { icon: <IconAlert size={22} />, title: "Agents get tricked", text: "An invoice footer says the bank details changed. The model believes it and pays the new address." },
  { icon: <IconReset size={22} />, title: "Agents loop", text: "One retry bug and the same refund goes out again and again, faster than anyone is watching." },
  { icon: <IconSliders size={22} />, title: "Agents split payments", text: "Six payments just under the limit add up to far more than the limit was meant to allow." },
];

export function Problem() {
  return (
    <section aria-labelledby="problem-title" className="mx-auto max-w-[1240px] px-4 py-10 sm:px-6 md:py-16">
      <h2 id="problem-title" className="display reveal max-w-[22ch] text-[clamp(1.9rem,4.6vw,3rem)]">
        An agent with a PayPal account is one bad document from a bad payment.
      </h2>
      <ul className="mt-8 grid gap-4 md:grid-cols-3">
        {PROBLEMS.map((p, i) => (
          <li key={p.title} className="panel reveal p-7" style={sty(i + 1)}>
            <span className="grid size-12 place-items-center rounded-full bg-lime text-accent-hi">{p.icon}</span>
            <h3 className="mt-5 text-xl">{p.title}</h3>
            <p className="mt-2 text-[15px] leading-relaxed text-dim">{p.text}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ------------------------------------------------------------------ 4. pipeline stepper */
type Tone = "deny" | "escalate" | "allow" | "info";
interface Step {
  title: string;
  line: string;
  checks: string[];
  outcome: { tone: Tone; text: string };
}
const STEPS: Step[] = [
  {
    title: "Authenticate, then check the kill switch",
    line: "The agent's key is checked first. A frozen agent, or a global freeze, is denied before any rule runs.",
    checks: ["Agent API key (stored hashed)", "Per-agent freeze and the global kill switch", "Circuit breaker freezes an agent after repeated denies"],
    outcome: { tone: "deny", text: "Frozen: denied at the first stage" },
  },
  {
    title: "Hard rules, no model involved",
    line: "Plain code decides on caps and patterns. An unknown tool, amount or currency is denied.",
    checks: ["Allowed tools and currencies", "Caps per payment, day, week and month", "Velocity, structuring, allowlist and blocklist"],
    outcome: { tone: "escalate", text: "Deny, or hold above the approval threshold" },
  },
  {
    title: "Payee trust checks",
    line: "Who is being paid, and does the story hold up? Each signal carries the evidence behind it.",
    checks: ["Look-alike of a known vendor's address", "Vendor name does not match the payee", "Recently changed payee, first-time payee, free-mail for a business"],
    outcome: { tone: "escalate", text: "Suspicious payee: held for a human" },
  },
  {
    title: "An AI reviewer that can only tighten",
    line: "It reads the call as untrusted data and may escalate or deny. It can never turn a deny or an escalate into an allow.",
    checks: ["Agent text is delimited and never obeyed", "Strictest decision wins", "If the reviewer fails, the call is escalated"],
    outcome: { tone: "info", text: "Tighten-only, with a rationale you can read" },
  },
  {
    title: "A human approves the risky ones",
    line: "Held calls wait in the Approvals queue with the reasons. Approving runs the stored call exactly once.",
    checks: ["Why the agent says it is paying, and where that came from", "Hard rules re-checked at approval time", "Approvals expire"],
    outcome: { tone: "escalate", text: "Approve or deny from the dashboard" },
  },
  {
    title: "Execute and write the ledger",
    line: "Only now does the call reach PayPal, with an idempotency key so a retry cannot pay twice.",
    checks: ["PayPal Payouts, or the PayPal MCP server for refunds and more", "Idempotency key on every executed call", "The result is written to the ledger"],
    outcome: { tone: "allow", text: "Executed and recorded" },
  },
  {
    title: "Reconcile with PayPal's webhooks",
    line: "PayPal's signed webhooks and Transaction Search are compared with the ledger, so money that moved outside Purser shows up.",
    checks: ["Webhook signature verified through PayPal", "Payout and capture events matched to ledger rows", "Anything unrecorded becomes a finding"],
    outcome: { tone: "info", text: "Matched, or flagged as a finding" },
  },
];

const TONE_CLS: Record<Tone, string> = {
  deny: "border-deny-line bg-deny-soft text-deny",
  escalate: "border-escalate-line bg-escalate-soft text-escalate",
  allow: "border-allow-line bg-allow-soft text-allow",
  info: "border-line-strong bg-sunken text-dim",
};

export function Pipeline() {
  const outer = useRef<HTMLElement>(null);
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    let raf = 0;
    const calc = () => {
      const el = outer.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const span = Math.max(1, r.height - window.innerHeight);
      const p = Math.min(0.9999, Math.max(0, -r.top / span));
      setIdx(Math.floor(p * STEPS.length));
    };
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(calc);
    };
    calc();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  const go = useCallback((i: number) => {
    const el = outer.current;
    if (!el) return;
    const span = el.offsetHeight - window.innerHeight;
    window.scrollTo({ top: el.offsetTop + ((i + 0.5) / STEPS.length) * span });
  }, []);

  const s = STEPS[idx] ?? STEPS[0]!;
  return (
    <section ref={outer} id="how" aria-labelledby="how-title" className="pipe" style={{ "--n": STEPS.length } as CSSProperties}>
      <div className="pipe-sticky">
        <div className="mx-auto w-full max-w-[1240px] px-4 sm:px-6">
          <p className="eyebrow">How a payment is judged</p>
          <h2 id="how-title" className="display mt-2 max-w-[20ch] text-[clamp(1.8rem,4.2vw,2.8rem)]">
            Seven checks between the agent and the money.
          </h2>

          <div className="mt-6 grid gap-6 md:mt-8 md:grid-cols-[0.8fr_1.2fr] md:gap-10">
            <ol className="hidden gap-1.5 md:grid" aria-label="Stages">
              {STEPS.map((st, i) => (
                <li key={st.title}>
                  <button
                    onClick={() => go(i)}
                    aria-current={i === idx ? "step" : undefined}
                    className={`focus-ring flex w-full items-center gap-3 rounded-full border px-3 py-2 text-left text-[14px] transition duration-[var(--duration-base)] ease-soft ${i === idx ? "border-lime-line bg-lime text-fg shadow-soft" : "border-transparent text-mute hover:bg-hover hover:text-fg"}`}
                  >
                    <span className={`num grid size-7 shrink-0 place-items-center rounded-full text-[12px] ${i === idx ? "bg-ink text-on-ink" : i < idx ? "bg-panel text-fg" : "bg-sunken text-mute"}`}>{i + 1}</span>
                    <span className="truncate">{st.title}</span>
                  </button>
                </li>
              ))}
            </ol>

            <div className="panel p-6 sm:p-8" aria-live="polite">
              <div className="flex items-center gap-3">
                <span className="num text-[12px] text-dim">
                  Step {idx + 1} of {STEPS.length}
                </span>
                <div className="pipe-bar flex-1" aria-hidden="true">
                  <span style={{ transform: `scaleX(${(idx + 1) / STEPS.length})` }} />
                </div>
              </div>
              <div key={idx} className="rise mt-5">
                <h3 className="text-[clamp(1.4rem,3vw,1.9rem)] leading-tight">{s.title}</h3>
                <p className="mt-3 text-[15.5px] leading-relaxed text-dim">{s.line}</p>
                <ul className="mt-5 grid gap-2">
                  {s.checks.map((c) => (
                    <li key={c} className="flex items-start gap-2.5 text-[14px] text-fg">
                      <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-ink" />
                      {c}
                    </li>
                  ))}
                </ul>
                <span className={`mt-6 inline-flex rounded-full border px-4 py-1.5 text-[12.5px] font-medium ${TONE_CLS[s.outcome.tone]}`}>{s.outcome.text}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ 5. attack scenario gallery */
interface Scenario {
  id: string;
  title: string;
  verdict: string;
  tone: Tone;
  summary: string;
  detail: string[];
  img: string;
  alt: string;
}
const SCENARIOS: Scenario[] = [
  {
    id: "A",
    title: "Poisoned invoice",
    verdict: "Held, then denied",
    tone: "escalate",
    summary: "An invoice says the payment details changed. The agent tries to pay a look-alike of a known vendor.",
    detail: ["Trust signals flag a look-alike payee, a vendor mismatch and a recently changed payee.", "The call is held in the Approvals queue with the AI reviewer's rationale.", "The human denies it. No money moves."],
    img: "a",
    alt: "Attack Lab after scenario A: the agent's log on the left, and on the right Purser's decision to escalate the $90 payout with look-alike and vendor-mismatch signals.",
  },
  {
    id: "B",
    title: "Structuring",
    verdict: "Blocked",
    tone: "deny",
    summary: "Six $90 payments to one vendor, each just under the per-payment cap.",
    detail: ["The first two payouts go through.", "The structuring rule and the daily cap deny the rest.", "Repeated denies trip the circuit breaker and freeze the agent."],
    img: "b",
    alt: "Attack Lab after scenario B: several $90 payouts denied by the daily cap and structuring rules, with the red frozen banner showing the circuit breaker tripped.",
  },
  {
    id: "C",
    title: "Runaway loop",
    verdict: "Blocked",
    tone: "deny",
    summary: "The same $1 refund, again and again, in a tight loop.",
    detail: ["The first refunds are allowed.", "The velocity rule denies the loop.", "The circuit breaker freezes the agent, and the kill switch stage denies everything after."],
    img: "c",
    alt: "Attack Lab after scenario C: refunds allowed at first, then denied by the velocity rule, and the agent frozen by the circuit breaker.",
  },
  {
    id: "D",
    title: "Happy path",
    verdict: "Allowed",
    tone: "allow",
    summary: "A legitimate $120 invoice from an allowlisted vendor.",
    detail: ["Every stage passes.", "The payout executes against the PayPal sandbox with an idempotency key.", "It lands in the ledger and on the Live page."],
    img: "d",
    alt: "Attack Lab after scenario D: the agent's log and Purser's decision to allow the $120 payout to an allowlisted vendor.",
  },
];

function Lightbox({ s, onClose }: { s: Scenario; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={`Scenario ${s.id}: ${s.title}`} onClick={onClose}>
      <div ref={ref} tabIndex={-1} className="lightbox-panel panel rise outline-none" onClick={(e) => e.stopPropagation()}>
        <div className="flex flex-wrap items-center gap-3 p-5 pb-3 sm:p-6 sm:pb-3">
          <span className="num grid size-9 place-items-center rounded-full bg-ink text-sm text-on-ink">{s.id}</span>
          <h3 className="text-2xl">{s.title}</h3>
          <span className={`rounded-full border px-3 py-1 text-[12px] font-medium ${TONE_CLS[s.tone]}`}>{s.verdict}</span>
          <button onClick={onClose} aria-label="Close" className="focus-ring ml-auto grid size-10 place-items-center rounded-full border border-line-strong text-dim transition hover:bg-hover hover:text-fg">
            <IconX size={16} />
          </button>
        </div>
        <img src={`/landing/scenario-${s.img}.webp`} alt={s.alt} width={1440} height={560} className="w-full" />
        <ul className="grid gap-2 p-5 sm:p-6">
          {s.detail.map((d) => (
            <li key={d} className="flex items-start gap-2.5 text-[14.5px] text-dim">
              <span className="mt-[8px] size-1.5 shrink-0 rounded-full bg-ink" />
              {d}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function Gallery() {
  const [open, setOpen] = useState<Scenario | null>(null);
  const close = useCallback(() => setOpen(null), []);
  return (
    <section id="scenarios" aria-labelledby="scn-title" className="mx-auto max-w-[1240px] scroll-mt-20 px-4 py-14 sm:px-6 md:py-20">
      <p className="eyebrow reveal">Attack Lab</p>
      <h2 id="scn-title" className="display reveal mt-2 max-w-[22ch] text-[clamp(1.9rem,4.6vw,3rem)]" style={sty(1)}>
        Four scenarios. Real decisions, replayable.
      </h2>
      <p className="reveal mt-3 max-w-[40rem] text-[15.5px] leading-relaxed text-dim" style={sty(2)}>
        These are screenshots of the real dashboard after each run against the PayPal sandbox. Click one for the full view.
      </p>
      <ul className="mt-8 grid gap-5 sm:grid-cols-2">
        {SCENARIOS.map((s, i) => (
          <li key={s.id} className="reveal" style={sty(i % 2)}>
            <button onClick={() => setOpen(s)} className="focus-ring panel group block w-full overflow-hidden text-left transition duration-[var(--duration-base)] ease-soft hover:-translate-y-1 hover:shadow-lift">
              <img src={`/landing/scenario-${s.img}-sm.webp`} alt={s.alt} width={800} height={256} loading="lazy" decoding="async" className="shot" />
              <div className="p-5 sm:p-6">
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className="num grid size-8 place-items-center rounded-full bg-ink text-[13px] text-on-ink">{s.id}</span>
                  <h3 className="text-xl">{s.title}</h3>
                  <span className={`ml-auto rounded-full border px-3 py-1 text-[12px] font-medium ${TONE_CLS[s.tone]}`}>{s.verdict}</span>
                </div>
                <p className="mt-3 text-[14.5px] leading-relaxed text-dim">{s.summary}</p>
                <span className="mt-3 inline-block text-[13px] font-medium text-accent-hi">Open larger view</span>
              </div>
            </button>
          </li>
        ))}
      </ul>
      {open && <Lightbox s={open} onClose={close} />}
    </section>
  );
}

/* ------------------------------------------------------------------ 6. proof strip */
function Stat({ value, label, sub, i }: { value: number; label: string; sub: string; i: number }) {
  const ref = useRef<HTMLLIElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver(([e]) => e?.isIntersecting && (setSeen(true), io.disconnect()), { threshold: 0.4 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const n = useCountUp(value, seen);
  return (
    <li ref={ref} className="panel reveal px-6 py-6" style={sty(i)}>
      <div className="num text-[2.6rem] leading-none tracking-[-0.04em] text-fg">{n}</div>
      <div className="mt-3 text-[15px] font-medium text-fg">{label}</div>
      <div className="mt-1 text-[13px] leading-snug text-dim">{sub}</div>
    </li>
  );
}

export function Proof() {
  return (
    <section id="proof" aria-labelledby="proof-title" className="mx-auto max-w-[1240px] scroll-mt-20 px-4 py-14 sm:px-6 md:py-20">
      <p className="eyebrow reveal">Proof</p>
      <h2 id="proof-title" className="display reveal mt-2 max-w-[24ch] text-[clamp(1.9rem,4.6vw,3rem)]" style={sty(1)}>
        Built on a real payment rail, with the numbers to check.
      </h2>
      <ul className="mt-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat i={0} value={facts.tests} label="automated tests" sub={`${facts.tests_server} server, ${facts.tests_agent} agent. Counted by running them.`} />
        <Stat i={1} value={facts.mcp_tools} label="MCP tools through the gateway" sub="PayPal's MCP tools plus three of Purser's own." />
        <Stat i={2} value={facts.hard_rules} label="hard rules, no model" sub="Deterministic code: caps, velocity, structuring, allowlists." />
        <Stat i={3} value={facts.pipeline_stages} label="pipeline stages" sub={`${facts.trust_signals} payee trust signals feed the reviewer.`} />
      </ul>
      <div className="panel-lime reveal mt-4 grid gap-5 p-6 sm:p-8 md:grid-cols-[1fr_auto] md:items-center" style={sty(2)}>
        <div>
          <h3 className="text-xl">Real PayPal sandbox, real signed webhooks</h3>
          <p className="mt-2 max-w-[46rem] text-[14.5px] leading-relaxed text-dim">
            Payouts, refunds and reconciliation run against PayPal&apos;s sandbox. On the hosted demo, a real payout produced a real signed webhook that passed PayPal&apos;s signature verification and matched its ledger row. No real money is involved.
          </p>
        </div>
        <ul className="flex flex-wrap gap-2 text-[12.5px] text-dim md:max-w-[18rem] md:justify-end">
          {["OAuth", "Payouts", "MCP server", "Webhooks", "Transaction Search"].map((t) => (
            <li key={t} className="rounded-full border border-line-strong bg-panel px-3 py-1">
              {t}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ 7. footer */
export function Footer({ children }: { children?: ReactNode }) {
  return (
    <footer className="mx-auto max-w-[1240px] px-4 pb-10 pt-6 sm:px-6">
      <div className="panel flex flex-col gap-6 p-7 sm:flex-row sm:items-center sm:justify-between sm:p-8">
        <div className="flex items-center gap-3">
          <LogoMark size={38} />
          <div>
            <div className="text-lg font-medium tracking-[-0.03em]">Purser</div>
            <div className="text-[13px] text-dim">Built for the PayPal AI Hackathon</div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <a href="https://github.com/Im-2/purser" rel="noopener" className="focus-ring inline-flex h-11 items-center rounded-full border border-line-strong bg-panel px-5 text-[14px] text-fg transition hover:border-lime-line hover:bg-hover">
            GitHub
          </a>
          <a href="/app" className="focus-ring inline-flex h-11 items-center rounded-full bg-ink px-5 text-[14px] font-medium text-on-ink shadow-pill transition hover:bg-ink-soft">
            Open the dashboard
          </a>
        </div>
      </div>
      <p className="mt-5 text-center text-[12.5px] leading-relaxed text-dim">
        Purser runs in the PayPal sandbox with test accounts. No real money moves, and no live PayPal credentials are used.
      </p>
      {children}
    </footer>
  );
}
