import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import { get } from "./api";
import { connectEvents, type ConnStatus, type EventName } from "./sse";
import { useToast } from "./toast";
import type { AgentInfo, ApprovalItem, Attempt, DemoStatus, ScenarioLog, Stats } from "./types";

const MAX_ATTEMPTS = 500;
const MAX_LOGS = 400;

interface State {
  ready: boolean;
  loadError: string | null;
  attempts: Attempt[];
  /** ids of attempts that just arrived (drives the row highlight) */
  fresh: Record<string, true>;
  approvals: ApprovalItem[];
  agents: AgentInfo[];
  globalFreeze: boolean;
  stats: Stats | null;
  logs: ScenarioLog[];
  conn: ConnStatus;
  demo: DemoStatus | null;
}

type Action =
  | { t: "attempts"; rows: Attempt[] }
  | { t: "attempt"; row: Attempt }
  | { t: "unfresh"; id: string }
  | { t: "approvals"; rows: ApprovalItem[] }
  | { t: "agents"; rows: AgentInfo[]; globalFreeze: boolean }
  | { t: "stats"; s: Stats }
  | { t: "log"; e: ScenarioLog }
  | { t: "clearLogs" }
  | { t: "conn"; s: ConnStatus }
  | { t: "demo"; d: DemoStatus }
  | { t: "ready" }
  | { t: "error"; message: string };

const initial: State = { ready: false, loadError: null, attempts: [], fresh: {}, approvals: [], agents: [], globalFreeze: false, stats: null, logs: [], conn: "connecting", demo: null };

function reduce(s: State, a: Action): State {
  switch (a.t) {
    case "attempts":
      return { ...s, attempts: a.rows.slice(0, MAX_ATTEMPTS) };
    case "attempt": {
      const i = s.attempts.findIndex((x) => x.id === a.row.id);
      if (i >= 0) {
        // the same attempt settled (execution finished, human decided): update in place
        const next = s.attempts.slice();
        next[i] = a.row;
        return { ...s, attempts: next };
      }
      return { ...s, attempts: [a.row, ...s.attempts].slice(0, MAX_ATTEMPTS), fresh: { ...s.fresh, [a.row.id]: true } };
    }
    case "unfresh": {
      if (!s.fresh[a.id]) return s;
      const { [a.id]: _gone, ...rest } = s.fresh;
      void _gone;
      return { ...s, fresh: rest };
    }
    case "approvals":
      return { ...s, approvals: a.rows };
    case "agents":
      return { ...s, agents: a.rows, globalFreeze: a.globalFreeze };
    case "stats":
      return { ...s, stats: a.s };
    case "log":
      return { ...s, logs: [...s.logs, a.e].slice(-MAX_LOGS) };
    case "clearLogs":
      return { ...s, logs: [] };
    case "conn":
      return { ...s, conn: a.s };
    case "demo":
      return { ...s, demo: a.d };
    case "ready":
      return { ...s, ready: true, loadError: null };
    case "error":
      return { ...s, loadError: a.message, ready: true };
  }
}

interface StoreApi {
  state: State;
  refreshAll: () => Promise<void>;
  refreshApprovals: () => Promise<void>;
  refreshAgents: () => Promise<void>;
  refreshStats: () => Promise<void>;
  clearLogs: () => void;
}
const Ctx = createContext<StoreApi | null>(null);
export const useStore = (): StoreApi => {
  const v = useContext(Ctx);
  if (!v) throw new Error("useStore outside StoreProvider");
  return v;
};

export function StoreProvider({ token, children }: { token: string; children: ReactNode }) {
  const [state, dispatch] = useReducer(reduce, initial);
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const refreshAttempts = useCallback(async () => {
    const r = await get<{ attempts: Attempt[] }>("/api/attempts?limit=300");
    dispatch({ t: "attempts", rows: r.attempts });
  }, []);
  const refreshApprovals = useCallback(async () => {
    const r = await get<{ approvals: ApprovalItem[] }>("/api/approvals");
    dispatch({ t: "approvals", rows: r.approvals });
  }, []);
  const refreshAgents = useCallback(async () => {
    const r = await get<{ global_freeze: boolean; agents: AgentInfo[] }>("/api/agents");
    dispatch({ t: "agents", rows: r.agents, globalFreeze: r.global_freeze });
  }, []);
  const refreshStats = useCallback(async () => {
    dispatch({ t: "stats", s: await get<Stats>("/api/stats") });
  }, []);
  const refreshDemo = useCallback(async () => {
    dispatch({ t: "demo", d: await get<DemoStatus>("/api/demo/status") });
  }, []);

  const refreshAll = useCallback(async () => {
    try {
      await Promise.all([refreshAttempts(), refreshApprovals(), refreshAgents(), refreshStats(), refreshDemo()]);
      dispatch({ t: "ready" });
    } catch (e) {
      dispatch({ t: "error", message: (e as Error).message });
    }
  }, [refreshAttempts, refreshApprovals, refreshAgents, refreshStats, refreshDemo]);

  // Debounced follow-up fetches: a burst of events (a scenario) causes one refresh, not twenty.
  const pending = useRef<Set<string>>(new Set());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const schedule = useCallback(
    (...kinds: ("stats" | "approvals" | "agents" | "demo")[]) => {
      kinds.forEach((k) => pending.current.add(k));
      if (timer.current) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        const k = new Set(pending.current);
        pending.current.clear();
        void Promise.allSettled([k.has("stats") && refreshStats(), k.has("approvals") && refreshApprovals(), k.has("agents") && refreshAgents(), k.has("demo") && refreshDemo()]);
      }, 350);
    },
    [refreshStats, refreshApprovals, refreshAgents, refreshDemo],
  );

  useEffect(() => {
    void refreshAll();
    const stop = connectEvents(token, {
      onStatus: (s) => dispatch({ t: "conn", s }),
      // (re)connected: fetch a fresh snapshot so nothing that happened while we were away is missing
      onOpen: () => void refreshAll(),
      onEvent: (name: EventName, data: unknown) => {
        switch (name) {
          case "attempt": {
            const row = data as Attempt;
            dispatch({ t: "attempt", row });
            setTimeout(() => dispatch({ t: "unfresh", id: row.id }), 3200);
            schedule("stats");
            break;
          }
          case "approval_created":
            schedule("approvals", "stats", "agents");
            break;
          case "approval_resolved":
            schedule("approvals", "stats", "agents");
            break;
          case "agent_status":
            schedule("agents", "stats");
            break;
          case "breaker_tripped": {
            const d = data as { agent_id: string; denies: number; window_sec: number };
            toastRef.current.push("error", "Circuit breaker tripped", `${d.agent_id} was frozen after ${d.denies} denies in ${d.window_sec}s.`);
            schedule("agents", "stats");
            break;
          }
          case "scenario_log": {
            const e = data as ScenarioLog;
            dispatch({ t: "log", e });
            if (e.kind === "done" || e.kind === "start") schedule("demo", "approvals", "agents", "stats");
            break;
          }
          case "reconciliation_finding":
            break; // the Reconciliation page arrives in part B
        }
      },
    });
    return () => {
      stop();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [token, refreshAll, schedule]);

  const value = useMemo<StoreApi>(() => ({ state, refreshAll, refreshApprovals, refreshAgents, refreshStats, clearLogs: () => dispatch({ t: "clearLogs" }) }), [state, refreshAll, refreshApprovals, refreshAgents, refreshStats]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
