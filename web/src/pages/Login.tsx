import { useState, type FormEvent } from "react";
import { Backdrop } from "../components/Backdrop";
import { LogoMark } from "../components/Logo";
import { Button } from "../components/ui";
import { ApiError, api, setRole, setToken, takeLoginNotice } from "../lib/api";

export function LoginPage({ onLogin }: { onLogin: (token: string) => void }) {
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [demoBusy, setDemoBusy] = useState(false);
  const [notice] = useState(takeLoginNotice);

  const [demoError, setDemoError] = useState<string | null>(null);
  const [waking, setWaking] = useState(false);
  const tryDemo = async () => {
    setDemoBusy(true);
    setDemoError(null);
    setWaking(false);
    try {
      // the free hosting sleeps when idle: a 502/503 or a dropped connection while it wakes is retried for about a minute
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await api<{ token: string }>("POST", "/api/demo-session", {}, "");
          setToken(r.token);
          setRole("demo");
          window.location.hash = "/lab"; // a judge's first stop is the Attack Lab
          onLogin(r.token);
          return;
        } catch (err) {
          const e2 = err as ApiError;
          const waking = e2.status === 0 || e2.status === 502 || e2.status === 504 || (e2.status === 503 && e2.code !== "demo_unavailable");
          if (!waking || attempt >= 20) throw err;
          setWaking(true);
          await new Promise((res) => setTimeout(res, 3000));
        }
      }
    } catch (err) {
      const e2 = err as ApiError;
      setDemoError(e2.status === 429 ? "Too many demo sessions from your network just now. Try again in a few minutes." : e2.status === 503 ? "Demo mode is not available on this server." : e2.status === 0 || e2.status === 502 || e2.status === 504 ? "The server is still waking up. Please try again in a moment." : e2.message);
    } finally {
      setDemoBusy(false);
      setWaking(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const token = value.trim();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await api("GET", "/api/stats", undefined, token); // the cheapest authenticated call: proves the token works
      setToken(token);
      setRole("admin");
      onLogin(token);
    } catch (err) {
      const e2 = err as ApiError;
      setError(e2.status === 401 ? "That token was not accepted." : e2.status === 503 ? "The admin API is disabled. Set PURSER_ADMIN_TOKEN on the server." : e2.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen place-items-center px-4 py-10">
      <Backdrop />
      <div className="grid w-full max-w-[1080px] items-center gap-10 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="relative hidden min-h-[460px] lg:block" aria-hidden="true">
          <div className="absolute left-4 top-6 animate-coin" style={{ perspective: 900 }}>
            <LogoMark size={360} shadow />
          </div>
          <div className="glass float absolute right-6 top-4 rounded-full px-4 py-2 text-[13px] text-dim">
            <span className="mr-2 inline-block size-2 rounded-full bg-allow" />Payout allowed
          </div>
          <div className="glass float-slow absolute bottom-16 right-0 rounded-full px-4 py-2 text-[13px] text-dim" style={{ animationDelay: "-3s" }}>
            <span className="mr-2 inline-block size-2 rounded-full bg-escalate" />Held for a human
          </div>
          <div className="glass float absolute bottom-2 left-8 rounded-full px-4 py-2 text-[13px] text-dim" style={{ animationDelay: "-5s" }}>
            <span className="mr-2 inline-block size-2 rounded-full bg-deny" />Look-alike payee denied
          </div>
        </div>

        <div className="w-full max-w-[460px] justify-self-center">
          <div className="mb-7">
            <div className="lg:hidden"><LogoMark size={56} /></div>
            <h1 className="display mt-4 text-[2.7rem] text-fg lg:mt-0">
              <span className="reveal-line" style={{ "--i": 0 } as React.CSSProperties}><span>Spending control</span></span>
              <span className="reveal-line" style={{ "--i": 1 } as React.CSSProperties}><span>for AI agents</span></span>
            </h1>
            <p className="rise mt-4 text-[15px] leading-relaxed text-dim" style={{ "--i": 4 } as React.CSSProperties}>Every payout, refund and invoice an agent attempts, decided and explained before money moves.</p>
          </div>

          <form onSubmit={submit} className="panel rise p-7" style={{ "--i": 5 } as React.CSSProperties} aria-label="Sign in">
            <label htmlFor="token" className="eyebrow">Admin token</label>
            <div className="relative mt-2">
              <input
                id="token"
                type={show ? "text" : "password"}
                autoFocus
                autoComplete="off"
                spellCheck={false}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="Paste PURSER_ADMIN_TOKEN"
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "token-error" : "token-help"}
                className={`focus-ring num h-12 w-full rounded-full border bg-sunken pl-5 pr-20 text-sm text-fg placeholder:font-sans placeholder:text-mute ${error ? "border-deny-line" : "border-line-strong"}`}
              />
              <button type="button" onClick={() => setShow((s) => !s)} className="focus-ring absolute right-2 top-1/2 -translate-y-1/2 rounded-full px-3 py-1.5 text-xs font-medium text-dim hover:bg-hover hover:text-fg">
                {show ? "Hide" : "Show"}
              </button>
            </div>
            {notice && !error && <p role="status" className="mt-3 rounded-[var(--radius-inner)] bg-escalate-soft px-3.5 py-2 text-[13px] text-escalate">{notice}</p>}
          {error ? (
              <p id="token-error" role="alert" className="mt-3 text-[13px] text-deny">{error}</p>
            ) : (
              <p id="token-help" className="mt-3 text-[12.5px] leading-snug text-mute">It is the PURSER_ADMIN_TOKEN value in your server&apos;s .env. It stays in this tab only and is cleared when you close it.</p>
            )}
            <Button type="submit" tone="primary" size="lg" busy={busy} disabled={!value.trim()} className="mt-5 w-full">
              Connect
            </Button>
          </form>

          <div className="rise mt-4 rounded-[var(--radius-card)] border border-lime-line bg-lime-soft p-5" style={{ "--i": 6 } as React.CSSProperties}>
            <div className="text-[15px] font-medium text-fg">No token? Try the demo.</div>
            <p className="mt-1 text-[13px] leading-snug text-dim">A private replay session for you alone: you can run all four attack scenarios and explore every page. Nothing touches PayPal, no money moves, and it expires after an hour.</p>
            <Button type="button" tone="ghost" busy={demoBusy} onClick={tryDemo} className="mt-3 w-full">
              Try the demo
            </Button>
            {waking && (
              <p role="status" className="mt-2.5 text-[13px] text-dim">
                Waking up the server. The free instance sleeps when idle and takes up to a minute to start. Hang on...
              </p>
            )}
            {demoError && (
              <p role="alert" className="mt-2.5 text-[13px] text-deny">
                {demoError}
              </p>
            )}
          </div>

          <p className="mt-5 text-center text-xs text-mute">Sandbox only. No live PayPal credentials.</p>
        </div>
      </div>
    </div>
  );
}
