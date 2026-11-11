import { describe, expect, it } from "vitest";
import type { Policy } from "@purser/shared";
import { defaultPolicy } from "../src/policy/defaults.js";
import { damerauLevenshtein, makeLookalike, skeleton, splitEmail } from "../src/trust/lookalike.js";
import { computeTrustSignals, type KnownPayee } from "../src/trust/signals.js";

const ACME = "acme-supplies@personal.example.com";
const NORTHWIND = "northwind-parts@personal.example.com";
const known: KnownPayee[] = [
  { email: ACME, display_name: "Acme Supplies" },
  { email: NORTHWIND, display_name: "Northwind Parts" },
];
const policy = (over: Partial<Policy["trust"]> = {}): Pick<Policy, "trust" | "payees"> => {
  const p = defaultPolicy({ agentId: "a", allowlist: [ACME, NORTHWIND] });
  return { trust: { ...p.trust, ...over }, payees: p.payees };
};
const run = (payee: string, o: { reason?: string; source?: string; args?: Record<string, unknown>; pol?: Pick<Policy, "trust" | "payees">; knownPayees?: KnownPayee[] } = {}) =>
  computeTrustSignals({ payeeEmail: payee, knownPayees: o.knownPayees ?? known, reason: o.reason ?? null, source: o.source ?? null, args: o.args ?? {}, policy: o.pol ?? policy() });
const ids = (r: ReturnType<typeof run>) => r.signals.map((s) => s.id).sort();

describe("distance and skeleton helpers", () => {
  it("damerau-levenshtein handles substitution, insertion, deletion and transposition", () => {
    expect(damerauLevenshtein("acme", "acme")).toBe(0);
    expect(damerauLevenshtein("acme", "acne")).toBe(1);
    expect(damerauLevenshtein("acme", "acmee")).toBe(1);
    expect(damerauLevenshtein("acme", "ace")).toBe(1);
    expect(damerauLevenshtein("acme", "amce")).toBe(1); // transposition counts once
    expect(damerauLevenshtein("", "abc")).toBe(3);
    expect(damerauLevenshtein("kitten", "sitting")).toBe(3);
  });
  it("skeleton collapses confusable spellings", () => {
    expect(skeleton("acme-supplies")).toBe(skeleton("acme-supp1ies"));
    expect(skeleton("northwind")).toBe(skeleton("n0rthwind"));
    expect(skeleton("acme")).toBe(skeleton("acrne")); // rn -> m
    expect(skeleton("acme")).toBe(skeleton("aacme")); // doubled letter
    expect(skeleton("acme")).toBe(skeleton("аcme")); // Cyrillic a
    expect(skeleton("acme")).not.toBe(skeleton("apex"));
  });
  it("splitEmail", () => {
    expect(splitEmail(" A@B.com ")).toEqual({ local: "a", domain: "b.com" });
    expect(splitEmail("nope")).toBeNull();
    expect(splitEmail("@b.com")).toBeNull();
  });
});

describe("makeLookalike", () => {
  it("is deterministic and keeps the domain", () => {
    expect(makeLookalike(ACME)).toBe(makeLookalike(ACME));
    expect(splitEmail(makeLookalike(ACME))!.domain).toBe("personal.example.com");
  });
  it("applies each swap kind", () => {
    expect(makeLookalike(NORTHWIND, "zero")).toBe("n0rthwind-parts@personal.example.com");
    expect(makeLookalike(ACME, "one")).toBe("acme-supp1ies@personal.example.com");
    expect(makeLookalike(ACME, "rn")).toBe("acrne-supplies@personal.example.com");
    expect(makeLookalike(ACME, "double")).toBe("aacme-supplies@personal.example.com");
  });
  it("default priority: o->0 first, then l->1, m->rn, then doubling", () => {
    expect(makeLookalike(NORTHWIND)).toBe("n0rthwind-parts@personal.example.com");
    expect(makeLookalike(ACME)).toBe("acme-supp1ies@personal.example.com"); // no "o" in the local part
    expect(makeLookalike("amy@x.com")).toBe("arny@x.com");
    expect(makeLookalike("bat@x.com")).toBe("bbat@x.com");
  });
  it("always differs from the input, even with no swappable letter", () => {
    for (const e of ["a@x.com", "xyz@x.com", "123@x.com", "q-r@x.com"]) expect(makeLookalike(e)).not.toBe(e);
  });
  it("rejects non-emails and falls back when the forced kind does not apply", () => {
    expect(() => makeLookalike("not-an-email")).toThrow();
    expect(makeLookalike("abc@x.com", "zero")).not.toBe("abc@x.com");
  });
});

describe("lookalike_payee: real-looking vendor emails with one character swapped", () => {
  const swaps: [string, string][] = [
    ["o -> 0", makeLookalike(NORTHWIND, "zero")],
    ["l -> 1", makeLookalike(ACME, "one")],
    ["m -> rn", makeLookalike(ACME, "rn")],
    ["doubled letter", makeLookalike(ACME, "double")],
    ["missing letter", "acme-suplies@personal.example.com"],
    ["transposed letters", "acme-suppiles@personal.example.com"],
    ["homoglyph (Cyrillic a)", "аcme-supplies@personal.example.com"],
  ];
  it.each(swaps)("flags %s", (_n, email) => {
    const r = run(email);
    expect(ids(r)).toContain("lookalike_payee");
    const sig = r.signals.find((s) => s.id === "lookalike_payee")!;
    expect(sig.severity).toBe("escalate");
    expect(sig.evidence).toMatch(/known payee/);
    expect(r.decision).toBe("escalate");
  });

  it("flags a typosquatted domain for the same mailbox name", () => {
    const r = run("acme-supplies@personal.examp1e.com");
    expect(ids(r)).toContain("lookalike_payee");
    expect(r.signals.find((s) => s.id === "lookalike_payee")!.evidence).toMatch(/domain/);
  });

  it("maps to deny when the policy says so", () => {
    const r = run(makeLookalike(ACME), { pol: policy({ lookalike: "deny" }) });
    expect(r.signals.find((s) => s.id === "lookalike_payee")!.severity).toBe("deny");
    expect(r.decision).toBe("deny");
  });
});

describe("no false positives", () => {
  it("an exact known payee produces no signals at all", () => {
    expect(run(ACME).signals).toEqual([]);
    expect(run(ACME.toUpperCase()).signals).toEqual([]);
  });
  it.each([
    "pinnacle-freight@personal.example.com",
    "blue-harbor-trading@personal.example.com",
    "acme-hardware@personal.example.com", // same brand prefix but a clearly different mailbox
    "northern-parts@personal.example.com",
    "accounts@globex-industries.com",
  ])("does not call %s a look-alike", (email) => {
    expect(ids(run(email))).not.toContain("lookalike_payee");
  });
  it("short mailbox names are not flagged by distance alone (bob vs rob)", () => {
    const r = run("rob@personal.example.com", { knownPayees: [{ email: "bob@personal.example.com", display_name: "Bob" }], pol: { ...policy(), payees: { mode: "open", allowlist: [], blocklist: [] } } });
    expect(ids(r)).not.toContain("lookalike_payee");
  });
  it("a different domain with a different mailbox is not a look-alike", () => {
    expect(ids(run("billing@unrelated.org"))).toEqual(["first_time_payee"]);
  });
  it("first_time_payee is informational only and never escalates by itself", () => {
    const r = run("pinnacle-freight@personal.example.com");
    expect(r.signals).toEqual([{ id: "first_time_payee", severity: "info", evidence: expect.any(String) }]);
    expect(r.decision).toBeUndefined();
  });
  it("invalid payee strings produce no signals", () => {
    expect(run("not-an-email").signals).toEqual([]);
  });
});

describe("vendor_mismatch", () => {
  it("fires when the reason names a known vendor but the payee is another address", () => {
    const r = run("pinnacle-freight@personal.example.com", { reason: "Pay Acme Supplies for the March invoice", source: "email from vendor" });
    expect(ids(r)).toContain("vendor_mismatch");
    expect(r.signals.find((s) => s.id === "vendor_mismatch")!.evidence).toContain("Acme Supplies");
    expect(r.decision).toBe("escalate");
  });
  it("fires when the reason refers to a known address but a different payee is used", () => {
    const r = run(makeLookalike(ACME), { reason: `Invoice from ${ACME}, pay as instructed` });
    expect(ids(r)).toEqual(expect.arrayContaining(["lookalike_payee", "vendor_mismatch"]));
  });
  it("fires for a declared invoice vendor that matches nothing about the payee", () => {
    const r = run("billing@unrelated.org", { args: { vendor: "Globex Corporation" } });
    expect(ids(r)).toContain("vendor_mismatch");
  });
  it("does not fire when the named vendor matches the payee", () => {
    expect(ids(run(ACME, { reason: "Pay Acme Supplies for March" }))).toEqual([]);
    expect(ids(run("accounts@globex.com", { args: { vendor: "Globex" } }))).not.toContain("vendor_mismatch");
  });
  it("does not fire on ordinary reasons that name no vendor", () => {
    expect(ids(run("pinnacle-freight@personal.example.com", { reason: "March freight invoice, approved by the owner" }))).toEqual(["first_time_payee"]);
  });
  it("honours the policy severity mapping", () => {
    const r = run("pinnacle-freight@personal.example.com", { reason: "Pay Acme Supplies", pol: policy({ vendor_mismatch: "deny" }) });
    expect(r.decision).toBe("deny");
  });
});

describe("payee_recently_changed", () => {
  it("fires when a known vendor appears under a new address", () => {
    const r = run("acme-billing@personal.example.com", { reason: "Pay Acme Supplies" });
    expect(ids(r)).toContain("payee_recently_changed");
    expect(r.signals.find((s) => s.id === "payee_recently_changed")!.evidence).toContain("Acme Supplies");
  });
  it("fires when the new address carries a known vendor's brand even without a mention", () => {
    expect(ids(run("northwind-accounts@personal.example.com"))).toContain("payee_recently_changed");
  });
  it("does not fire for the known address or an unrelated payee", () => {
    expect(ids(run(NORTHWIND))).toEqual([]);
    expect(ids(run("pinnacle-freight@personal.example.com"))).not.toContain("payee_recently_changed");
  });
});

describe("free_mail_for_business", () => {
  it("fires for a business-named vendor paid at a free-mail domain", () => {
    const r = run("acme.supplies@gmail.com", { reason: "Pay Acme Supplies" });
    expect(ids(r)).toContain("free_mail_for_business");
    expect(r.signals.find((s) => s.id === "free_mail_for_business")!.evidence).toContain("gmail.com");
  });
  it("fires for a declared business vendor name", () => {
    expect(ids(run("jsmith@outlook.com", { args: { vendor: "Pinnacle Freight Ltd" } }))).toContain("free_mail_for_business");
  });
  it("does not fire for individuals, business domains, or known addresses", () => {
    expect(ids(run("jane.doe@gmail.com", { reason: "reimburse Jane for travel" }))).not.toContain("free_mail_for_business");
    expect(ids(run("accounts@acme-supplies.com", { reason: "Pay Acme Supplies" }))).not.toContain("free_mail_for_business");
    expect(ids(run("acme@gmail.com", { knownPayees: [{ email: "acme@gmail.com", display_name: "Acme Supplies" }] }))).toEqual([]);
  });
});

describe("combined and policy-driven", () => {
  it("scenario A: poisoned invoice yields lookalike + vendor_mismatch + recently_changed, strictest wins", () => {
    const r = run(makeLookalike(ACME), { reason: "Pay Acme Supplies March invoice. Updated payment details attached.", source: "vendor invoice PDF" });
    expect(ids(r)).toEqual(expect.arrayContaining(["first_time_payee", "lookalike_payee", "vendor_mismatch", "payee_recently_changed"]));
    expect(r.decision).toBe("escalate");
  });
  it("the allowlist counts as known even when the payees table is empty", () => {
    expect(run(ACME, { knownPayees: [] }).signals).toEqual([]);
    expect(ids(run(makeLookalike(ACME), { knownPayees: [] }))).toContain("lookalike_payee");
  });
  it("is deterministic and never produces an allow decision", () => {
    const a = run(makeLookalike(ACME), { reason: "Pay Acme Supplies" });
    expect(run(makeLookalike(ACME), { reason: "Pay Acme Supplies" })).toEqual(a);
    expect([undefined, "escalate", "deny"]).toContain(a.decision);
  });
});
