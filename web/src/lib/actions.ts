import { useMemo } from "react";
import { ApiError, post } from "./api";
import { useStore } from "./store";
import { useToast } from "./toast";

const msg = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message);

/** Operator actions. Each one reports its outcome as a toast; the SSE feed then updates the screen. */
export function useActions() {
  const { refreshAll, refreshApprovals, refreshAgents, refreshStats } = useStore();
  const toast = useToast();

  return useMemo(
    () => ({
      async freezeAll(): Promise<boolean> {
        try {
          await post("/api/freeze-all");
          toast.push("error", "All agents frozen", "Every tool call is now denied at the kill switch.");
          await Promise.all([refreshAgents(), refreshStats()]);
          return true;
        } catch (e) {
          toast.push("error", "Could not freeze", msg(e));
          return false;
        }
      },
      async unfreezeAll(): Promise<boolean> {
        try {
          await post("/api/unfreeze-all");
          toast.push("success", "Agents unfrozen", "Tool calls are being evaluated again.");
          await Promise.all([refreshAgents(), refreshStats()]);
          return true;
        } catch (e) {
          toast.push("error", "Could not unfreeze", msg(e));
          return false;
        }
      },
      async setAgentFrozen(id: string, name: string, frozen: boolean): Promise<void> {
        try {
          await post(`/api/agents/${id}/${frozen ? "freeze" : "unfreeze"}`);
          toast.push(frozen ? "warn" : "success", frozen ? `${name} frozen` : `${name} unfrozen`);
          await Promise.all([refreshAgents(), refreshStats()]);
        } catch (e) {
          toast.push("error", "Could not change the agent", msg(e));
        }
      },
      async approve(id: string): Promise<boolean> {
        try {
          const r = await post<{ approval: { result?: { executed: boolean; payout_batch_id?: string; error?: string } }; result?: { message?: string; amount?: string; recipient?: string } }>(`/api/approvals/${id}/approve`);
          const res = r.approval.result;
          if (res?.executed) toast.push("success", "Approved and executed", [r.result?.amount, r.result?.recipient, res.payout_batch_id && `batch ${res.payout_batch_id}`].filter(Boolean).join(" · "));
          else toast.push("warn", "Approved, but it did not execute", res?.error ?? "PayPal rejected the call. See the attempt for details.");
          await refreshAll();
          return true;
        } catch (e) {
          toast.push("error", "Could not approve", msg(e));
          await refreshApprovals();
          return false;
        }
      },
      async deny(id: string): Promise<boolean> {
        try {
          await post(`/api/approvals/${id}/deny`);
          toast.push("info", "Denied", "The call was closed. No money moved.");
          await refreshAll();
          return true;
        } catch (e) {
          toast.push("error", "Could not deny", msg(e));
          await refreshApprovals();
          return false;
        }
      },
      async runScenario(id: string, mode: "replay" | "live", reset: boolean): Promise<{ run_id: string } | null> {
        try {
          return await post<{ run_id: string }>(`/api/demo/run/${id}`, { mode, reset });
        } catch (e) {
          toast.push("error", "Could not start the scenario", msg(e));
          return null;
        }
      },
      async resetDemo(): Promise<boolean> {
        try {
          const r = await post<{ attempts_cleared: number; policy_restored: boolean }>("/api/demo/reset");
          toast.push("success", "Demo reset", `${r.attempts_cleared} attempts cleared, agents unfrozen, seeded policy restored.`);
          await refreshAll();
          return true;
        } catch (e) {
          toast.push("error", "Could not reset", msg(e));
          return false;
        }
      },
    }),
    [toast, refreshAll, refreshApprovals, refreshAgents, refreshStats],
  );
}
