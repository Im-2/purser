import { useEffect, useRef, useState, type CSSProperties } from "react";
import { LogoMark } from "../components/Logo";
import { prefersReducedMotion } from "./hooks";

export function Orb({ size, rings = false }: { size?: string; rings?: boolean }) {
  return (
    <div className="orb-wrap" style={size ? ({ "--s": size } as CSSProperties) : undefined}>
      <div className="orb-glow" aria-hidden="true" />
      {rings && (
        <>
          <span className="orb-ring" aria-hidden="true" />
          <span className="orb-ring" aria-hidden="true" />
          <span className="orb-ring" aria-hidden="true" />
        </>
      )}
      <div className="orb orb-bob" aria-hidden="true" />
    </div>
  );
}

/** Intro: an orb and a percentage that resolves into the hero. Skippable with the button, Escape or Enter. */
export function Loader({ onDone }: { onDone: () => void }) {
  const [pct, setPct] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const done = useRef(false);

  const finish = () => {
    if (done.current) return;
    done.current = true;
    setLeaving(true);
    window.setTimeout(onDone, 480);
  };

  useEffect(() => {
    document.body.style.overflow = "hidden";
    let raf = 0;
    const t0 = performance.now();
    const MS = 1500;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / MS);
      setPct(Math.round(100 * (1 - Math.pow(1 - k, 2.2))));
      if (k < 1) raf = requestAnimationFrame(step);
      else finish();
    };
    raf = requestAnimationFrame(step);
    const onKey = (e: KeyboardEvent) => (e.key === "Escape" || e.key === "Enter") && finish();
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, []);

  return (
    <div className={`loader ${leaving ? "leaving" : ""}`} role="dialog" aria-modal="true" aria-label="Loading Purser">
      <div className="flex flex-col items-center gap-7">
        <div className="orb" aria-hidden="true" />
        <div className="loader-count" role="status" aria-live="off">
          {pct}%
        </div>
        <button onClick={finish} className="focus-ring rounded-full border border-line-strong bg-panel px-5 py-2 text-[13px] text-dim transition hover:bg-hover hover:text-fg" autoFocus>
          Skip intro
        </button>
      </div>
    </div>
  );
}

const NAV = [
  { href: "#how", label: "How it works" },
  { href: "#scenarios", label: "Attacks" },
  { href: "#proof", label: "Proof" },
];

export function Nav() {
  return (
    <header className="sticky top-0 z-40 px-4 pt-3 sm:px-6">
      <div className="glass mx-auto flex h-[60px] max-w-[1240px] items-center gap-3 rounded-full px-3 pl-5">
        <a href="#top" className="focus-ring mr-auto flex items-center gap-2.5 rounded-full" aria-label="Purser, back to top">
          <LogoMark size={30} />
          <span className="text-[1.15rem] font-medium tracking-[-0.04em]">Purser</span>
        </a>
        <nav aria-label="Sections" className="hidden items-center gap-1 md:flex">
          {NAV.map((n) => (
            <a key={n.href} href={n.href} className="focus-ring rounded-full px-4 py-2 text-[13.5px] text-dim transition hover:bg-hover hover:text-fg">
              {n.label}
            </a>
          ))}
        </nav>
        <a href="/app" className="focus-ring inline-flex h-10 items-center rounded-full bg-ink px-5 text-[13px] font-medium text-on-ink shadow-pill transition hover:bg-ink-soft">
          Open the dashboard
        </a>
      </div>
    </header>
  );
}

const CHIPS = [
  { text: "Payout allowed", dot: "bg-allow", cls: "right-0 top-2 md:right-2", delay: "0s" },
  { text: "Held for a human", dot: "bg-escalate", cls: "bottom-14 right-0 md:-right-2", delay: "-3s" },
  { text: "Look-alike payee denied", dot: "bg-deny", cls: "bottom-0 left-0 md:left-2", delay: "-5s" },
];

export function Hero() {
  const ref = useRef<HTMLElement>(null);

  // the orb leans toward the pointer (fine pointers only; off with reduced motion)
  useEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion() || !window.matchMedia("(pointer: fine)").matches) return;
    let raf = 0;
    const move = (e: PointerEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        el.style.setProperty("--px", String(((e.clientX - r.left) / r.width - 0.5) * 2));
        el.style.setProperty("--py", String(((e.clientY - r.top) / r.height - 0.5) * 2));
      });
    };
    el.addEventListener("pointermove", move);
    return () => {
      el.removeEventListener("pointermove", move);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <section ref={ref} id="top" aria-labelledby="hero-title" className="relative mx-auto grid max-w-[1240px] items-center gap-10 px-4 pb-16 pt-10 sm:px-6 md:min-h-[calc(100vh-72px)] md:grid-cols-[1.05fr_0.95fr] md:pt-6">
      <div className="relative z-10">
        <p className="hero-anim rise eyebrow" style={{ "--i": 0 } as CSSProperties}>
          Spending firewall for AI agents on PayPal
        </p>
        <h1 id="hero-title" className="display mt-4 text-[clamp(2.6rem,7.4vw,5rem)] text-fg">
          <span className="reveal-line hero-anim" style={{ "--i": 0 } as CSSProperties}>
            <span>Let your agents spend.</span>
          </span>
          <span className="reveal-line hero-anim" style={{ "--i": 1 } as CSSProperties}>
            <span>Not overspend.</span>
          </span>
        </h1>
        <p className="hero-anim rise mt-6 max-w-[34rem] text-[clamp(1rem,2.2vw,1.2rem)] leading-relaxed text-dim" style={{ "--i": 4 } as CSSProperties}>
          Purser sits between an AI agent and PayPal. It stops the forged invoice, the runaway loop and the split payment before any money moves, and shows you why.
        </p>
        <div className="hero-anim rise mt-8 flex flex-wrap items-center gap-3" style={{ "--i": 5 } as CSSProperties}>
          <a href="/app" className="focus-ring inline-flex h-12 items-center rounded-full bg-ink px-7 text-[15px] font-medium text-on-ink shadow-pill transition duration-[var(--duration-fast)] hover:bg-ink-soft active:scale-[0.98]">
            Open the dashboard
          </a>
          <a href="#scenarios" className="focus-ring inline-flex h-12 items-center rounded-full border border-line-strong bg-panel px-7 text-[15px] font-medium text-fg transition duration-[var(--duration-fast)] hover:border-lime-line hover:bg-hover active:scale-[0.98]">
            Watch the attack demo
          </a>
        </div>
        <p className="hero-anim rise mt-6 text-[12.5px] text-dim" style={{ "--i": 6 } as CSSProperties}>
          Runs in the PayPal sandbox. No real money.
        </p>
      </div>

      <div className="hero-anim rise relative mx-auto grid w-full max-w-[460px] place-items-center py-6" style={{ "--i": 2 } as CSSProperties} aria-hidden="true">
        <div className="relative grid place-items-center" style={{ ["--s" as string]: "clamp(220px, 62vw, 380px)" }}>
          <Orb rings />
          {CHIPS.map((c) => (
            <span key={c.text} className={`glass chip-float absolute rounded-full px-4 py-2 text-[13px] text-dim ${c.cls}`} style={{ animationDelay: c.delay }}>
              <span className={`mr-2 inline-block size-2 rounded-full ${c.dot}`} />
              {c.text}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
