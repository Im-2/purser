import { useEffect, useState } from "react";

export const prefersReducedMotion = (): boolean => typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);

const INTRO_KEY = "purser_intro_seen";
/** The intro plays once per browser session, and never with reduced motion. Storage may be blocked: then it just plays. */
export function shouldShowIntro(): boolean {
  if (prefersReducedMotion()) return false;
  try {
    return sessionStorage.getItem(INTRO_KEY) === null;
  } catch {
    return true;
  }
}
export function markIntroSeen(): void {
  try {
    sessionStorage.setItem(INTRO_KEY, "1");
  } catch {
    // ignore
  }
}

/** Adds .in to every .reveal element as it scrolls into view. Elements already in view on load are revealed at once. */
export function useScrollReveal(enabled: boolean): void {
  useEffect(() => {
    document.documentElement.classList.add("js");
    if (!enabled) return;
    const els = Array.from(document.querySelectorAll<HTMLElement>(".reveal"));
    if (prefersReducedMotion() || typeof IntersectionObserver === "undefined") {
      els.forEach((e) => e.classList.add("in"));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          if (en.isIntersecting) {
            en.target.classList.add("in");
            io.unobserve(en.target);
          }
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.12 },
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, [enabled]);
}

/** Counts from 0 to `target` once `start` is true. Honors reduced motion by jumping to the final value. */
export function useCountUp(target: number, start: boolean, ms = 1100): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (!start) return;
    if (prefersReducedMotion()) {
      setV(target);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      setV(Math.round(target * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, start, ms]);
  return v;
}
