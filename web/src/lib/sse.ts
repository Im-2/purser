/**
 * Server-Sent Events with automatic reconnect. EventSource cannot set headers, so the admin token goes in ?token= (the
 * server never logs query strings). EventSource retries by itself on a dropped connection; if the browser gives up
 * (readyState CLOSED, for example after a server restart) we reconnect with backoff.
 */

export type ConnStatus = "connecting" | "live" | "reconnecting";

export const EVENT_NAMES = ["attempt", "approval_created", "approval_resolved", "agent_status", "breaker_tripped", "reconciliation_finding", "scenario_log"] as const;
export type EventName = (typeof EVENT_NAMES)[number];

export interface StreamHandlers {
  onEvent: (name: EventName, data: unknown) => void;
  onStatus: (s: ConnStatus) => void;
  /** Called on every (re)connect so the app can refetch a snapshot and not miss anything while disconnected. */
  onOpen: () => void;
}

export function connectEvents(token: string, h: StreamHandlers): () => void {
  let es: EventSource | null = null;
  let stopped = false;
  let retry = 1000;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const open = () => {
    if (stopped) return;
    h.onStatus("connecting");
    es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
    es.onopen = () => {
      retry = 1000;
      h.onStatus("live");
      h.onOpen();
    };
    for (const name of EVENT_NAMES) {
      es.addEventListener(name, (ev) => {
        try {
          h.onEvent(name, JSON.parse((ev as MessageEvent<string>).data));
        } catch {
          // ignore a malformed frame
        }
      });
    }
    es.onerror = () => {
      h.onStatus("reconnecting");
      if (es && es.readyState === EventSource.CLOSED) {
        es.close();
        es = null;
        if (!stopped) {
          timer = setTimeout(open, retry);
          retry = Math.min(retry * 2, 10_000);
        }
      }
    };
  };
  open();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    es?.close();
  };
}
