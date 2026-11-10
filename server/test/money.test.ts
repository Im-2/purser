import { describe, expect, it } from "vitest";
import { fromMinor, mulMinor, toMinor } from "../src/money.js";

describe("toMinor", () => {
  it.each([
    ["12.50", 1250],
    ["0.07", 7],
    ["100", 10000],
    [12.5, 1250],
    [0.1, 10],
    ["  3.4 ", 340],
  ])("parses %s", (input, expected) => expect(toMinor(input)).toBe(expected));

  it.each(["", "abc", "-5", "1.234", "1e3", "NaN", "1,000.00", "$5"])("rejects %j", (input) =>
    expect(toMinor(input)).toBeNull(),
  );
  it.each([NaN, Infinity, -1, 1e21, null, undefined, {}, []])("rejects non-money %j", (input) =>
    expect(toMinor(input as unknown)).toBeNull(),
  );

  it("never accumulates float error", () => {
    // 0.1 + 0.2 !== 0.3 in floats; in minor units it is exact.
    expect((toMinor(0.1) ?? 0) + (toMinor(0.2) ?? 0)).toBe(toMinor(0.3));
  });
});

describe("fromMinor / mulMinor", () => {
  it("formats", () => {
    expect(fromMinor(1250)).toBe("12.50");
    expect(fromMinor(5)).toBe("0.05");
    expect(fromMinor(0)).toBe("0.00");
  });
  it("multiplies integers only", () => {
    expect(mulMinor(1999, 3)).toBe(5997);
    expect(mulMinor(100, 1.5)).toBeNull();
    expect(mulMinor(100, -1)).toBeNull();
  });
});
