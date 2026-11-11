import { useState, type FormEvent } from "react";
import { Logo } from "../components/Logo";
import { Button } from "../components/ui";
import { ApiError, api, setToken } from "../lib/api";

export function LoginPage({ onLogin }: { onLogin: (token: string) => void }) {
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const token = value.trim();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await api("GET", "/api/stats", undefined, token); // the cheapest authenticated call: proves the token works
      setToken(token);
      onLogin(token);
    } catch (err) {
      const e2 = err as ApiError;
      setError(e2.status === 401 ? "That token was not accepted." : e2.status === 503 ? "The admin API is disabled. Set PURSER_ADMIN_TOKEN on the server." : e2.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-full place-items-center px-4 py-10">
      <div className="w-full max-w-[420px]">
        <div className="mb-8 flex flex-col items-center text-center">
          <Logo size={52} />
          <h1 className="mt-6 text-[1.65rem] font-semibold leading-tight tracking-tight">Mission control for agent spending</h1>
          <p className="mt-2 text-sm leading-relaxed text-dim">Every payout, refund and invoice an AI agent attempts, decided and explained before money moves.</p>
        </div>

        <form onSubmit={submit} className="panel p-6" aria-label="Sign in">
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
              className={`focus-ring num h-12 w-full rounded-lg border bg-sunken pl-4 pr-16 text-sm text-fg placeholder:font-sans placeholder:text-mute ${error ? "border-deny/60" : "border-line-strong"}`}
            />
            <button type="button" onClick={() => setShow((s) => !s)} className="focus-ring absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-2.5 py-1.5 text-xs font-semibold text-dim hover:bg-hover hover:text-fg">
              {show ? "Hide" : "Show"}
            </button>
          </div>
          {error ? (
            <p id="token-error" role="alert" className="mt-2.5 text-[13px] text-deny">{error}</p>
          ) : (
            <p id="token-help" className="mt-2.5 text-[12.5px] leading-snug text-mute">It is the PURSER_ADMIN_TOKEN value in your server's .env. It stays in this tab only and is cleared when you close it.</p>
          )}
          <Button type="submit" tone="primary" size="lg" busy={busy} disabled={!value.trim()} className="mt-5 w-full">
            Connect
          </Button>
        </form>

        <p className="mt-6 text-center text-xs text-mute">Sandbox only. No live PayPal credentials.</p>
      </div>
    </div>
  );
}
