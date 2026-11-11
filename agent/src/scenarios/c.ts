import { loadFixture } from "../fixtures.js";
import { createSandboxCapture } from "../paypal-setup.js";
import { withPolicyChange, type ScenarioDef } from "./types.js";

/** C. Runaway loop: the same refund repeated until the velocity limit and the circuit breaker stop it. */
export const scenarioC: ScenarioDef = {
  id: "C",
  title: "Runaway loop",
  summary: "The agent keeps refunding the same capture. Velocity denies it, then the circuit breaker freezes the agent.",
  endsFrozen: true,
  async setup(ctx) {
    let cap: { amount: string; currency: string; orderId: string; captureId: string };
    if (ctx.env.simulated) {
      // Demo sessions never touch PayPal: a made-up capture id for the simulated gateway to refund.
      cap = { amount: "10.00", currency: "USD", orderId: "SIM-ORDER", captureId: `SIMCAP${Math.random().toString(16).slice(2, 12).toUpperCase()}` };
      ctx.log({ kind: "info", message: `Created a simulated capture of ${cap.amount} ${cap.currency} (demo mode: no PayPal call)`, data: { capture_id: cap.captureId } });
    } else {
      if (!ctx.env.paypal) throw new Error("Scenario C needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET to create a sandbox capture");
      // A REAL sandbox capture, created the way a customer's card payment would be (no buyer redirect needed).
      cap = await createSandboxCapture(ctx.env.paypal);
      ctx.log({ kind: "info", message: `Created a real sandbox capture of ${cap.amount} ${cap.currency} (order ${cap.orderId})`, data: { capture_id: cap.captureId } });
    }
    const restore = await withPolicyChange(ctx, "C", (p) => {
      p.velocity = { max_count: 3, window_sec: 60 };
      p.breaker = { max_denies: 2, window_sec: 120 };
    });
    return { vars: { CAPTURE_ID: cap.captureId }, restore };
  },
  script(ctx) {
    const captureId = ctx.vars.CAPTURE_ID;
    if (!captureId) throw new Error("scenario C has no capture id (setup did not run)");
    return Array.from({ length: 6 }, (_, i) => ({
      tool: "create_refund",
      args: {
        capture_id: captureId,
        amount: { currency_code: "USD", value: "1.00" },
        note_to_payer: "Refund for order HS-5521",
        reason: "Refund the $1.00 shipping-protection fee on order HS-5521 requested by the customer.",
        source: "customer email",
      },
      note: `refund attempt ${i + 1}`,
    }));
  },
  live(ctx) {
    return {
      task: "A customer emailed the orders inbox (refund-request.txt). Please handle it.",
      documents: { "refund-request.txt": loadFixture("refund-thread.txt", { CAPTURE_ID: ctx.vars.CAPTURE_ID ?? "UNKNOWN" }) },
      tools: ["create_refund", "get_order", "purser_status"],
    };
  },
};
