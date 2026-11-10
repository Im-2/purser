import { describe, expect, it } from "vitest";
import { classifyTool } from "../src/policy/classify.js";
import { extractCall } from "../src/policy/extract.js";

describe("classifyTool", () => {
  it.each([
    ["get_order", "read"],
    ["list_invoices", "read"],
    ["show_subscription_details", "read"],
    ["purser_status", "read"],
    ["purser_check_approval", "read"],
    ["create_order", "money_in"],
    ["create_invoice", "money_in"],
    ["create_subscription", "money_in"],
    ["create_subscription_plan", "money_in"],
    ["create_product", "money_in"],
    ["send_invoice", "outbound_comms"],
    ["send_invoice_reminder", "outbound_comms"],
    ["pay_order", "capture"],
    ["capture_order", "capture"],
    ["create_refund", "money_out"],
    ["purser_payout", "money_out"],
    ["batch_payout_send", "money_out"],
    ["issue_refund_now", "money_out"],
  ])("%s -> %s", (tool, cls) => expect(classifyTool(tool)).toBe(cls));

  it.each(["delete_everything", "update_invoice", "cancel_subscription", "", "   ", "constructor", "__proto__"])(
    "unknown/odd tool %j is unknown (denied)",
    (tool) => expect(classifyTool(tool)).toBe("unknown"),
  );

  it("is config-driven: exact map beats regex fallbacks", () => {
    const cfg = { exact: { list_secrets: "money_out" as const }, patterns: [{ re: /^list_/, cls: "read" as const }] };
    expect(classifyTool("list_secrets", cfg)).toBe("money_out");
    expect(classifyTool("list_other", cfg)).toBe("read");
    expect(classifyTool("other", cfg)).toBe("unknown");
  });
});

describe("extractCall", () => {
  const table: [string, string, unknown, { amountMinor: number | null; currency: string | null; payeeEmail: string | null }][] = [
    [
      "create_order sums items x quantity",
      "create_order",
      { currency_code: "USD", items: [{ name: "a", quantity: "2", unit_amount: { value: "10.50", currency_code: "USD" } }, { name: "b", quantity: 1, unit_amount: "4.25" }] },
      { amountMinor: 2525, currency: "USD", payeeEmail: null },
    ],
    [
      "create_order adds shipping and tax",
      "create_order",
      { currency_code: "usd", items: [{ quantity: 1, price: "10.00" }], shipping_amount: "2.00", tax_amount: { value: "0.80" } },
      { amountMinor: 1280, currency: "USD", payeeEmail: null },
    ],
    [
      "create_order purchase_units fallback",
      "create_order",
      { purchase_units: [{ amount: { value: "99.99", currency_code: "USD" } }] },
      { amountMinor: 9999, currency: "USD", payeeEmail: null },
    ],
    ["create_order with a bad item is unknown", "create_order", { currency_code: "USD", items: [{ quantity: 1, unit_amount: "abc" }] }, { amountMinor: null, currency: "USD", payeeEmail: null }],
    ["create_order with empty items is unknown", "create_order", { items: [] }, { amountMinor: null, currency: null, payeeEmail: null }],
    ["create_order fractional quantity is unknown", "create_order", { items: [{ quantity: 1.5, unit_amount: "2.00" }] }, { amountMinor: null, currency: null, payeeEmail: null }],
    [
      "create_invoice with recipient",
      "create_invoice",
      { invoice: { items: [{ quantity: "3", unit_amount: { value: "20.00", currency_code: "USD" } }], primary_recipients: [{ billing_info: { email_address: "Bill@Example.com" } }] } },
      { amountMinor: 6000, currency: "USD", payeeEmail: "bill@example.com" },
    ],
    ["create_invoice flat amount", "create_invoice", { amount: { value: "75.00", currency_code: "USD" } }, { amountMinor: 7500, currency: "USD", payeeEmail: null }],
    ["create_refund with amount object", "create_refund", { capture_id: "C1", amount: { value: "30.00", currency_code: "USD" } }, { amountMinor: 3000, currency: "USD", payeeEmail: null }],
    ["create_refund with amount string", "create_refund", { capture_id: "C1", amount: "12.34", currency_code: "USD" }, { amountMinor: 1234, currency: "USD", payeeEmail: null }],
    ["create_refund without amount is unknown (full refund)", "create_refund", { capture_id: "C1" }, { amountMinor: null, currency: null, payeeEmail: null }],
    ["create_refund with negative amount is unknown", "create_refund", { capture_id: "C1", amount: "-5.00" }, { amountMinor: null, currency: null, payeeEmail: null }],
    ["create_refund with zero amount is unknown", "create_refund", { capture_id: "C1", amount: "0.00" }, { amountMinor: null, currency: null, payeeEmail: null }],
    ["purser_payout basic", "purser_payout", { recipient_email: "Acme@Example.com", amount: 120, currency: "USD" }, { amountMinor: 12000, currency: "USD", payeeEmail: "acme@example.com" }],
    ["purser_payout alt keys", "purser_payout", { payee_email: "x@y.com", amount: { value: "5.00", currency_code: "USD" } }, { amountMinor: 500, currency: "USD", payeeEmail: "x@y.com" }],
    ["purser_payout invalid email is no payee", "purser_payout", { recipient_email: "not-an-email", amount: "5.00", currency: "USD" }, { amountMinor: 500, currency: "USD", payeeEmail: null }],
    ["purser_payout missing amount", "purser_payout", { recipient_email: "a@b.co", currency: "USD" }, { amountMinor: null, currency: "USD", payeeEmail: "a@b.co" }],
    ["pay_order with amount", "pay_order", { order_id: "O1", amount: "40.00", currency_code: "USD" }, { amountMinor: 4000, currency: "USD", payeeEmail: null }],
    ["pay_order without amount is unknown", "pay_order", { order_id: "O1" }, { amountMinor: null, currency: null, payeeEmail: null }],
    ["non-object args", "purser_payout", "oops", { amountMinor: null, currency: null, payeeEmail: null }],
    ["null args", "create_order", null, { amountMinor: null, currency: null, payeeEmail: null }],
  ];
  it.each(table)("%s", (_name, tool, args, expected) => expect(extractCall(tool, args)).toEqual(expected));
});
