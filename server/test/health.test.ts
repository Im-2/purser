import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

describe("config", () => {
  it("applies defaults", () => {
    const c = loadConfig({});
    expect(c.PORT).toBe(8799);
    expect(c.PAYPAL_ENV).toBe("sandbox");
  });

  it("rejects live PayPal env", () => {
    expect(() => loadConfig({ PAYPAL_ENV: "live" })).toThrow(/Invalid environment/);
  });

  it("treats empty strings as unset", () => {
    expect(loadConfig({ PORT: "", ANTHROPIC_API_KEY: "" }).ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe("GET /health", () => {
  it("returns ok", async () => {
    const app = buildApp(loadConfig({ LOG_LEVEL: "silent" }));
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
    await app.close();
  });
});
