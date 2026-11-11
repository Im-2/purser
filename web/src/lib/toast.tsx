import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

export type ToastKind = "success" | "error" | "info" | "warn";
interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
  body?: string;
}
interface ToastApi {
  push: (kind: ToastKind, title: string, body?: string) => void;
}

const Ctx = createContext<ToastApi>({ push: () => undefined });
export const useToast = () => useContext(Ctx);

const TONE: Record<ToastKind, string> = {
  success: "border-allow/40 text-allow",
  error: "border-deny/50 text-deny",
  warn: "border-escalate/50 text-escalate",
  info: "border-accent/50 text-accent-hi",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const push = useCallback((kind: ToastKind, title: string, body?: string) => {
    const id = ++seq.current;
    setItems((xs) => [...xs.slice(-3), { id, kind, title, body }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), kind === "error" ? 8000 : 5000);
  }, []);
  const api = useMemo(() => ({ push }), [push]);
  return (
    <Ctx.Provider value={api}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed bottom-5 right-5 z-[70] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2">
        {items.map((t) => (
          <div key={t.id} className={`pointer-events-auto animate-rise rounded-xl border bg-raised/95 px-4 py-3 shadow-2xl backdrop-blur ${TONE[t.kind]}`}>
            <div className="text-sm font-semibold">{t.title}</div>
            {t.body && <div className="mt-0.5 text-[13px] leading-snug text-dim">{t.body}</div>}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
