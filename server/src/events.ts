import { EventEmitter } from "node:events";
import type { AttemptRecord, PurserEvent } from "@purser/shared";
import type { AttemptRow } from "./db/repos.js";

/** In-process event bus. SSE (prompt 6) subscribes; the pipeline publishes. Subscriber errors never affect publishers. */
export interface EventBus {
  publish(event: PurserEvent): void;
  subscribe(fn: (event: PurserEvent) => void): () => void;
}

export function createEventBus(): EventBus {
  const em = new EventEmitter();
  em.setMaxListeners(100);
  return {
    publish(event) {
      for (const fn of em.listeners("event") as ((e: PurserEvent) => void)[]) {
        try {
          fn(event);
        } catch {
          // a broken subscriber must not break the pipeline
        }
      }
    },
    subscribe(fn) {
      em.on("event", fn);
      return () => void em.off("event", fn);
    },
  };
}

const parse = <T>(s: string | null, fallback: T): T => {
  if (s === null) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

/** Convert a DB row to the shared AttemptRecord shape (amount stays in integer minor units). */
export function attemptRowToRecord(r: AttemptRow): AttemptRecord {
  return {
    id: r.id,
    agent_id: r.agent_id,
    ts: new Date(r.ts).toISOString(),
    tool: r.tool,
    tool_class: r.tool_class,
    args: parse<Record<string, unknown>>(r.args_json, {}),
    amount: r.amount,
    currency: r.currency,
    payee_email: r.payee_email,
    reason: r.reason,
    source: r.source,
    decision: r.decision,
    decision_stage: r.decision_stage as AttemptRecord["decision_stage"],
    rule_hits: parse<{ id: string }[]>(r.rule_hits_json, []).map((h) => (typeof h === "string" ? h : h.id)),
    signals: parse<(string | { id: string })[]>(r.signals_json, []).map((s) => (typeof s === "string" ? s : s.id)),
    ai: parse(r.ai_json, null),
    approval_id: r.approval_id,
    upstream_result: parse(r.upstream_result_json, null),
    ledger_id: r.ledger_id,
    latency_ms: r.latency_ms,
  };
}
