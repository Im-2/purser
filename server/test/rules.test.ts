import { describe, expect, it } from "vitest";
import type { Policy, ToolClass } from "@purser/shared";
import { defaultPolicy } from "../src/policy/defaults.js";
import { combine, evaluateRules, matchesAction, type HistoryEntry, type RuleCall, type RuleHit, type RuleInput } from "../src/policy/rules.js";

const ACME = "acme@personal.example.com";
const NEW = "stranger@personal.example.com";
const NOW = 1_800_000_000_000;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const policy = (over: Partial<Policy> = {}): Policy => ({ ...defaultPolicy({ agentId: "a", allowlist: [ACME] }), ...over });
const payout = (amountDollars: number | null, payee: string | null = ACME, over: Partial<RuleCall> = {}): RuleCall => ({
  toolClass: "money_out",
  tool: "purser_payout",
  amountMinor: amountDollars === null ? null : Math.round(amountDollars * 100),
  currency: "USD",
  payeeEmail: payee,
  ...over,
});
const hist = (over: Partial<HistoryEntry> & { agoMs?: number } = {}): HistoryEntry => ({
  tsMs: NOW - (over.agoMs ?? 1000),
  toolClass: "money_out",
  amountMinor: 1000,
  payeeEmail: ACME,
  decision: "allow",
  ...over,
});
const run = (call: RuleCall, over: { policy?: Policy; history?: HistoryEntry[] } = {}) =>
  evaluateRules({ call, policy: over.policy ?? policy(), history: over.history ?? [], nowMs: NOW });
const ids = (r: { hits: RuleHit[] }) => r.hits.map((h) => h.id).sort();

describe("matchesAction", () => {
  it("handles exact, globs, case and regex metacharacters", () => {
    expect(matchesAction("create_refund", ["create_refund"])).toBe(true);
    expect(matchesAction("list_invoices", ["list_*"])).toBe(true);
    expect(matchesAction("get_order", ["list_*"])).toBe(false);
    expect(matchesAction("CREATE_REFUND", ["create_refund"])).toBe(true);
    expect(matchesAction("anything", ["*"])).toBe(true);
    expect(matchesAction("a.b", ["a.b"])).toBe(true);
    expect(matchesAction("axb", ["a.b"])).toBe(false);
    expect(matchesAction("create_refund_extra", ["create_refund"])).toBe(false);
    expect(matchesAction("x", [])).toBe(false);
  });
});

describe("baseline", () => {
  it("allows the happy path: $120 to an allowlisted vendor", () => {
    const r = run(payout(120));
    expect(r.decision).toBe("allow");
    expect(r.hits).toEqual([]);
  });
  it("read tools always pass at this stage, whatever the policy says", () => {
    const strict = policy({ allowed_actions: [], currency_allowed: ["EUR"] });
    const r = run({ toolClass: "read", tool: "list_invoices", amountMinor: null, currency: null, payeeEmail: null }, { policy: strict });
    expect(r.decision).toBe("allow");
  });
  it("unknown tool is denied", () => {
    const r = run({ toolClass: "unknown", tool: "delete_all", amountMinor: null, currency: null, payeeEmail: null });
    expect(r.decision).toBe("deny");
    expect(ids(r)).toEqual(["unknown_tool"]);
  });
  it("agent message never leaks thresholds or the allowlist", () => {
    const r = run(payout(999, NEW));
    expect(r.decision).toBe("deny");
    expect(r.agentMessage).not.toMatch(/\d|cap|allowlist|threshold|limit/i);
    expect(JSON.stringify(r.agentMessage)).not.toContain(ACME);
  });
});

describe("each rule alone", () => {
  it("action_not_allowed", () => {
    const r = run(payout(10), { policy: policy({ allowed_actions: ["create_refund"] }) });
    expect(r.decision).toBe("deny");
    expect(ids(r)).toEqual(["action_not_allowed"]);
  });

  it("currency_not_allowed", () => {
    const r = run(payout(10, ACME, { currency: "EUR" }));
    expect(r.decision).toBe("deny");
    expect(ids(r)).toEqual(["currency_not_allowed"]);
  });
  it("currency match is case-insensitive", () => {
    expect(run(payout(10, ACME, { currency: "usd" })).decision).toBe("allow");
  });
  it("currency_unknown fails closed to escalate", () => {
    const r = run(payout(10, ACME, { currency: null }));
    expect(r.decision).toBe("escalate");
    expect(ids(r)).toEqual(["currency_unknown"]);
  });

  it("per_tx_cap: equal is allowed, one cent over is denied", () => {
    const p = policy({ approval_threshold: 1000 });
    expect(run(payout(200), { policy: p }).decision).toBe("allow");
    const r = run({ ...payout(200), amountMinor: 20001 }, { policy: p });
    expect(r.decision).toBe("deny");
    expect(ids(r)).toContain("per_tx_cap");
  });
  it("per_tx_cap also applies to money_in and capture", () => {
    for (const [toolClass, tool] of [["money_in", "create_order"], ["capture", "pay_order"]] as [ToolClass, string][]) {
      const r = run({ toolClass, tool, amountMinor: 30000, currency: "USD", payeeEmail: null }, { policy: policy({ allowed_actions: ["*"] }) });
      expect(r.decision).toBe("deny");
      expect(ids(r)).toEqual(["per_tx_cap"]);
    }
  });

  it("amount_unknown fails closed to escalate (null and non-positive)", () => {
    for (const amountMinor of [null, 0, -5]) {
      const r = run({ ...payout(1), amountMinor });
      expect(r.decision).toBe("escalate");
      expect(ids(r)).toEqual(["amount_unknown"]);
    }
  });
  it("amount_unknown also applies to money_in and capture", () => {
    for (const [toolClass, tool] of [["money_in", "create_order"], ["capture", "pay_order"]] as [ToolClass, string][]) {
      const r = run({ toolClass, tool, amountMinor: null, currency: "USD", payeeEmail: null }, { policy: policy({ allowed_actions: ["*"] }) });
      expect(r.decision).toBe("escalate");
      expect(ids(r)).toEqual(["amount_unknown"]);
    }
  });
  it("outbound_comms needs no amount", () => {
    const r = run({ toolClass: "outbound_comms", tool: "send_invoice", amountMinor: null, currency: null, payeeEmail: null }, { policy: policy({ allowed_actions: ["send_invoice"] }) });
    expect(r.decision).toBe("allow");
  });

  it("approval_threshold escalates above, not at", () => {
    expect(run(payout(150)).decision).toBe("allow");
    const r = run(payout(150.01));
    expect(r.decision).toBe("escalate");
    expect(ids(r)).toEqual(["approval_threshold"]);
  });

  it("payee_blocklisted denies (case-insensitive)", () => {
    const r = run(payout(10, "ACME@personal.example.com"), { policy: policy({ payees: { mode: "open", allowlist: [], blocklist: [ACME] } }) });
    expect(r.decision).toBe("deny");
    expect(ids(r)).toEqual(["payee_blocklisted"]);
  });

  describe("allowlist modes", () => {
    const mk = (mode: Policy["payees"]["mode"]) => policy({ payees: { mode, allowlist: [ACME], blocklist: [] } });
    it("strict denies unknown payees", () => {
      const r = run(payout(10, NEW), { policy: mk("strict") });
      expect(r.decision).toBe("deny");
      expect(ids(r)).toEqual(["payee_not_allowlisted"]);
    });
    it("first_time_requires_approval escalates", () => {
      const r = run(payout(10, NEW), { policy: mk("first_time_requires_approval") });
      expect(r.decision).toBe("escalate");
      expect(ids(r)).toEqual(["payee_not_allowlisted"]);
    });
    it("open continues", () => {
      expect(run(payout(10, NEW), { policy: mk("open") }).decision).toBe("allow");
    });
    it("allowlisted payee is fine in every mode, case-insensitively", () => {
      for (const m of ["strict", "first_time_requires_approval", "open"] as const) {
        expect(run(payout(10, "Acme@Personal.Example.com"), { policy: mk(m) }).decision).toBe("allow");
      }
    });
    it("a missing payee on a payout fails closed to escalate, even in open mode", () => {
      const r = run(payout(10, null), { policy: mk("open") });
      expect(r.decision).toBe("escalate");
      expect(ids(r)).toEqual(["payee_unknown"]);
    });
  });

  it("refunds skip allowlist rules but keep caps, and the blocklist still applies", () => {
    const refund = (amt: number | null, payee: string | null = null): RuleCall => ({
      toolClass: "money_out",
      tool: "create_refund",
      amountMinor: amt === null ? null : amt * 100,
      currency: "USD",
      payeeEmail: payee,
    });
    expect(run(refund(30)).decision).toBe("allow");
    expect(run(refund(30, NEW)).decision).toBe("allow");
    expect(run(refund(null)).decision).toBe("escalate");
    expect(run(refund(250)).decision).toBe("deny");
    const blocked = run(refund(30, NEW), { policy: policy({ payees: { mode: "open", allowlist: [], blocklist: [NEW] } }) });
    expect(blocked.decision).toBe("deny");
  });
});

describe("rolling spend caps", () => {
  const p = policy({ approval_threshold: 1000, limits: { per_tx_cap: 200, daily_cap: 500, weekly_cap: 1000, monthly_cap: 1500 }, velocity: { max_count: 1000, window_sec: 60 }, structuring: { window_sec: 900, min_count: 99, near_cap_ratio: 0.8, action: "deny" } });
  const spend = (cents: number, agoMs: number, over: Partial<HistoryEntry> = {}) => hist({ amountMinor: cents, agoMs, ...over });

  it("daily: sum + amount equal to cap is allowed, one cent over is denied", () => {
    const history = [spend(30000, 1 * 60 * MIN)];
    expect(run(payout(200), { policy: p, history }).decision).toBe("allow");
    const r = run({ ...payout(200), amountMinor: 20001 }, { policy: p, history });
    expect(r.decision).toBe("deny");
    expect(ids(r)).toContain("daily_cap");
  });
  it("window edge: exactly 24h old is outside, 1 ms younger is inside", () => {
    const outside = [spend(50000, DAY)];
    expect(run(payout(10), { policy: p, history: outside }).decision).toBe("allow");
    const inside = [spend(50000, DAY - 1)];
    const r = run(payout(10), { policy: p, history: inside });
    expect(r.decision).toBe("deny");
    expect(ids(r)).toContain("daily_cap");
  });
  it("weekly and monthly are independent windows", () => {
    // 2 days ago spends: outside daily, inside weekly
    const h = [spend(45000, 2 * DAY), spend(45000, 3 * DAY)];
    const r = run(payout(150), { policy: p, history: h });
    expect(r.decision).toBe("deny");
    expect(ids(r)).toEqual(["weekly_cap"]);
    // 10 and 12 days ago: outside weekly, inside monthly
    const h2 = [spend(80000, 10 * DAY), spend(80000, 12 * DAY)];
    const r2 = run(payout(150), { policy: p, history: h2 });
    expect(ids(r2)).toEqual(["monthly_cap"]);
    // 31 days ago: outside everything
    expect(run(payout(150), { policy: p, history: [spend(500000, 31 * DAY)] }).decision).toBe("allow");
  });
  it("only allowed money_out counts as spend", () => {
    const history = [
      spend(50000, 1000, { decision: "deny" }),
      spend(50000, 1000, { decision: "escalate" }),
      spend(50000, 1000, { toolClass: "money_in" }),
      spend(50000, 1000, { toolClass: "read" }),
    ];
    expect(run(payout(100), { policy: p, history }).decision).toBe("allow");
  });
  it("uses integer arithmetic: many small spends add exactly", () => {
    const history = Array.from({ length: 49 }, (_, i) => spend(1000, 1000 + i)); // 49 x $10.00 = $490.00
    expect(run(payout(10), { policy: p, history }).decision).toBe("allow"); // exactly $500.00
    expect(run({ ...payout(10), amountMinor: 1001 }, { policy: p, history }).decision).toBe("deny");
  });
  it("future-dated history is ignored", () => {
    expect(run(payout(10), { policy: p, history: [spend(500000, -DAY)] }).decision).toBe("allow");
  });
});

describe("velocity", () => {
  const p = policy({ velocity: { max_count: 3, window_sec: 60 }, limits: { per_tx_cap: 200, daily_cap: 100000, weekly_cap: 100000, monthly_cap: 100000 } });
  const calls = (n: number, agoMs = 1000, over: Partial<HistoryEntry> = {}) => Array.from({ length: n }, (_, i) => hist({ agoMs: agoMs + i, amountMinor: 100, payeeEmail: `v${i}@x.com`, ...over }));

  it("the current call counts: max_count prior calls trips, max_count-1 does not", () => {
    expect(run(payout(1), { policy: p, history: calls(2) }).decision).toBe("allow");
    const r = run(payout(1), { policy: p, history: calls(3) });
    expect(r.decision).toBe("deny");
    expect(ids(r)).toEqual(["velocity"]);
  });
  it("window edge", () => {
    expect(run(payout(1), { policy: p, history: calls(3, 60 * 1000) }).decision).toBe("allow");
    expect(run(payout(1), { policy: p, history: calls(3, 60 * 1000 - 3) }).decision).toBe("deny");
  });
  it("counts denied attempts too (a runaway loop keeps tripping)", () => {
    expect(run(payout(1), { policy: p, history: calls(3, 1000, { decision: "deny" }) }).decision).toBe("deny");
  });
  it("counts money_in, capture and outbound_comms but not reads", () => {
    for (const toolClass of ["money_in", "capture", "outbound_comms"] as ToolClass[]) {
      expect(run(payout(1), { policy: p, history: calls(3, 1000, { toolClass }) }).decision).toBe("deny");
    }
    expect(run(payout(1), { policy: p, history: calls(10, 1000, { toolClass: "read" }) }).decision).toBe("allow");
  });
  it("applies to outbound_comms", () => {
    const pc = policy({ allowed_actions: ["send_invoice"], velocity: { max_count: 1, window_sec: 60 } });
    const call: RuleCall = { toolClass: "outbound_comms", tool: "send_invoice", amountMinor: null, currency: null, payeeEmail: null };
    expect(run(call, { policy: pc, history: calls(1, 1000, { toolClass: "outbound_comms" }) }).decision).toBe("deny");
  });
});

describe("structuring", () => {
  const p = policy({
    limits: { per_tx_cap: 100, daily_cap: 100000, weekly_cap: 100000, monthly_cap: 100000 },
    approval_threshold: 100,
    velocity: { max_count: 1000, window_sec: 60 },
    structuring: { window_sec: 900, min_count: 3, near_cap_ratio: 0.8, action: "deny" },
  });
  const prior = (cents: number, agoMs: number, payee = ACME, over: Partial<HistoryEntry> = {}) => hist({ amountMinor: cents, agoMs, payeeEmail: payee, ...over });

  it("trips on the third near-cap payment to the same payee", () => {
    const h = [prior(9000, 2000), prior(9000, 1000)];
    const r = run(payout(90), { policy: p, history: h });
    expect(r.decision).toBe("deny");
    expect(ids(r)).toEqual(["structuring"]);
    // two payments are not yet a pattern
    expect(run(payout(90), { policy: p, history: [prior(9000, 1000)] }).decision).toBe("allow");
  });
  it("near-cap boundary: exactly ratio*cap counts, one cent below does not (when the sum is under cap)", () => {
    const small = policy({ ...p, limits: { per_tx_cap: 1000, daily_cap: 1e6, weekly_cap: 1e6, monthly_cap: 1e6 }, approval_threshold: 1000, structuring: { window_sec: 900, min_count: 3, near_cap_ratio: 0.8, action: "deny" } });
    // each exactly 800.00 == 0.8 * 1000 -> near cap
    expect(run(payout(800), { policy: small, history: [prior(80000, 2000), prior(80000, 1000)] }).decision).toBe("deny");
    // 799.99 is below the ratio, but the sum still exceeds the cap -> still structuring
    expect(ids(run({ ...payout(1), amountMinor: 79999 }, { policy: small, history: [prior(79999, 2000), prior(79999, 1000)] }))).toContain("structuring");
  });
  it("many small payments under near-cap and under cap in total are fine", () => {
    const h = [prior(1000, 2000), prior(1000, 1000)];
    expect(run(payout(10), { policy: p, history: h }).decision).toBe("allow");
  });
  it("trips when the sum would exceed the cap even if each is small", () => {
    const h = [prior(4000, 2000), prior(4000, 1000)];
    const r = run(payout(40), { policy: p, history: h }); // 120 > 100
    expect(ids(r)).toContain("structuring");
    expect(r.decision).toBe("deny");
  });
  it("only counts the same payee, inside the window", () => {
    const other = [prior(9000, 2000, NEW), prior(9000, 1000, NEW)];
    expect(run(payout(90), { policy: p, history: other }).decision).toBe("allow");
    const old = [prior(9000, 900 * 1000), prior(9000, 900 * 1000 + 5)];
    expect(run(payout(90), { policy: p, history: old }).decision).toBe("allow");
    const edge = [prior(9000, 900 * 1000 - 1), prior(9000, 900 * 1000 - 2)];
    expect(run(payout(90), { policy: p, history: edge }).decision).toBe("deny");
  });
  it("payee match is case-insensitive and counts prior denied attempts", () => {
    const h = [prior(9000, 2000, ACME.toUpperCase(), { decision: "deny" }), prior(9000, 1000, ACME, { decision: "deny" })];
    expect(run(payout(90), { policy: p, history: h }).decision).toBe("deny");
  });
  it("action: escalate yields escalate", () => {
    const pe = policy({ ...p, structuring: { ...p.structuring, action: "escalate" } });
    const r = run(payout(90), { policy: pe, history: [prior(9000, 2000), prior(9000, 1000)] });
    expect(r.decision).toBe("escalate");
    expect(ids(r)).toEqual(["structuring"]);
  });
  it("scenario B: six $90 payouts, cap $100, daily $250", () => {
    const sp = policy({
      limits: { per_tx_cap: 100, daily_cap: 250, weekly_cap: 1500, monthly_cap: 4000 },
      approval_threshold: 150,
      velocity: { max_count: 8, window_sec: 60 },
      structuring: { window_sec: 900, min_count: 3, near_cap_ratio: 0.8, action: "deny" },
      payees: { mode: "first_time_requires_approval", allowlist: [ACME], blocklist: [] },
    });
    const history: HistoryEntry[] = [];
    const outcomes: string[] = [];
    for (let i = 0; i < 6; i++) {
      const now = NOW + i * 1000;
      const r = evaluateRules({ call: payout(90), policy: sp, history, nowMs: now });
      outcomes.push(r.decision);
      history.push({ tsMs: now, toolClass: "money_out", amountMinor: 9000, payeeEmail: ACME, decision: r.decision });
    }
    // first two allowed (180 <= 250), the third trips structuring, and every later call is denied
    expect(outcomes).toEqual(["allow", "allow", "deny", "deny", "deny", "deny"]);
  });
});

describe("rules in combination", () => {
  it("collects every hit, strictest wins", () => {
    const r = run(payout(999, NEW, { currency: "EUR" }));
    expect(r.decision).toBe("deny");
    expect(ids(r)).toEqual(expect.arrayContaining(["currency_not_allowed", "per_tx_cap", "approval_threshold", "payee_not_allowlisted"]));
  });
  it("deny outranks escalate on the same call", () => {
    const r = run(payout(160, NEW), { policy: policy({ payees: { mode: "first_time_requires_approval", allowlist: [], blocklist: [NEW] } }) });
    expect(r.decision).toBe("deny");
    expect(r.hits.some((h) => h.severity === "escalate")).toBe(true);
  });
  it("amount unknown plus unlisted payee: still escalate, and payee hit is reported", () => {
    const r = run(payout(null, NEW));
    expect(r.decision).toBe("escalate");
    expect(ids(r)).toEqual(["amount_unknown", "payee_not_allowlisted"]);
  });
  it("amount unknown cannot dodge the blocklist or action list", () => {
    const r = run(payout(null, NEW), { policy: policy({ allowed_actions: ["create_refund"], payees: { mode: "open", allowlist: [], blocklist: [NEW] } }) });
    expect(r.decision).toBe("deny");
  });
  it("hits carry internal detail that the agent message omits", () => {
    const r = run(payout(250));
    const hit = r.hits.find((h) => h.id === "per_tx_cap");
    expect(hit?.detail).toMatchObject({ amount: 25000, cap: 20000 });
    expect(r.agentMessage).not.toContain("20000");
  });
  it("is pure: same input, same output, input not mutated", () => {
    const input: RuleInput = { call: payout(250, NEW), policy: policy(), history: [hist()], nowMs: NOW };
    const snapshot = JSON.stringify(input);
    const a = evaluateRules(input);
    const b = evaluateRules(input);
    expect(a).toEqual(b);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

// Deterministic PRNG so failures are reproducible.
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("property: a deny hit can never end in allow", () => {
  const classes: ToolClass[] = ["read", "money_in", "capture", "money_out", "outbound_comms", "unknown"];
  const tools = ["purser_payout", "create_refund", "create_order", "pay_order", "send_invoice", "list_invoices", "weird_tool"];
  const payees = [null, ACME, NEW, "BLOCKED@x.com", "Acme@Personal.Example.com"];
  const currencies = [null, "USD", "usd", "EUR"];
  const amounts = [null, 0, -100, 1, 4999, 5000, 15000, 15001, 20000, 20001, 99999999];

  it("holds across 5000 random policies, calls and histories", () => {
    const rnd = mulberry32(1234);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
    let denies = 0;
    let escalates = 0;
    let allows = 0;
    for (let i = 0; i < 5000; i++) {
      const pol = policy({
        allowed_actions: pick([["*"], ["purser_payout", "list_*"], [], ["create_refund", "create_order", "pay_order", "send_invoice"]]),
        currency_allowed: pick([["USD"], ["EUR"], ["USD", "EUR"]]),
        limits: { per_tx_cap: pick([50, 200, 1000]), daily_cap: pick([100, 500, 5000]), weekly_cap: pick([500, 1500]), monthly_cap: pick([1500, 4000]) },
        approval_threshold: pick([10, 150, 5000]),
        payees: { mode: pick(["strict", "first_time_requires_approval", "open"] as const), allowlist: pick([[ACME], [], [ACME, NEW]]), blocklist: pick([[], ["blocked@x.com"]]) },
        velocity: { max_count: pick([1, 3, 8]), window_sec: pick([30, 60, 600]) },
        structuring: { window_sec: pick([60, 900]), min_count: pick([2, 3, 5]), near_cap_ratio: pick([0.5, 0.8, 1]), action: pick(["deny", "escalate"] as const) },
      });
      const history = Array.from({ length: Math.floor(rnd() * 12) }, () =>
        hist({
          agoMs: Math.floor(rnd() * 40 * DAY),
          toolClass: pick(classes),
          amountMinor: pick(amounts),
          payeeEmail: pick(payees),
          decision: pick(["allow", "deny", "escalate"] as const),
        }),
      );
      const call: RuleCall = { toolClass: pick(classes), tool: pick(tools), amountMinor: pick(amounts), currency: pick(currencies), payeeEmail: pick(payees) };
      const r = evaluateRules({ call, policy: pol, history, nowMs: NOW });

      const anyDeny = r.hits.some((h) => h.severity === "deny");
      const anyEscalate = r.hits.some((h) => h.severity === "escalate");
      if (anyDeny) expect(r.decision).toBe("deny");
      else if (anyEscalate) expect(r.decision).toBe("escalate");
      else expect(r.decision).toBe("allow");
      expect(combine(r.hits)).toBe(r.decision);
      if (r.decision === "allow") expect(r.hits).toEqual([]);
      // an unknown tool class must never be allowed
      if (call.toolClass === "unknown") expect(r.decision).toBe("deny");
      // a blocklisted payee must never be allowed
      if (call.toolClass !== "read" && call.toolClass !== "unknown" && call.payeeEmail && pol.payees.blocklist.includes(call.payeeEmail.toLowerCase())) expect(r.decision).toBe("deny");
      if (r.decision === "deny") denies++;
      else if (r.decision === "escalate") escalates++;
      else allows++;
    }
    // sanity: the generator actually exercises all three outcomes
    expect(denies).toBeGreaterThan(100);
    expect(escalates).toBeGreaterThan(50);
    expect(allows).toBeGreaterThan(50);
  });

  it("adding history or tightening limits never turns a deny into an allow", () => {
    const rnd = mulberry32(99);
    for (let i = 0; i < 1000; i++) {
      const base = policy();
      const call = payout([5, 90, 140, 160, 250, 999][Math.floor(rnd() * 6)] as number, [ACME, NEW][Math.floor(rnd() * 2)] as string);
      const r1 = evaluateRules({ call, policy: base, history: [], nowMs: NOW });
      const extra = Array.from({ length: 1 + Math.floor(rnd() * 6) }, (_, k) => hist({ agoMs: 1000 + k, amountMinor: 9000, payeeEmail: ACME }));
      const r2 = evaluateRules({ call, policy: base, history: extra, nowMs: NOW });
      const rank = { allow: 0, escalate: 1, deny: 2 } as const;
      expect(rank[r2.decision]).toBeGreaterThanOrEqual(rank[r1.decision]);
    }
  });
});
