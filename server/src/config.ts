import { z } from "zod";

const emptyToUndef = (v: unknown) => (v === "" ? undefined : v);
const optStr = z.preprocess(emptyToUndef, z.string().optional());

export const EnvSchema = z.object({
  PAYPAL_CLIENT_ID: optStr,
  PAYPAL_CLIENT_SECRET: optStr,
  PAYPAL_ENV: z.literal("sandbox").default("sandbox"),
  PAYPAL_WEBHOOK_ID: optStr,
  BUSINESS_EMAIL: optStr,
  VENDOR_ACME_EMAIL: optStr,
  VENDOR_NORTHWIND_EMAIL: optStr,
  ANTHROPIC_API_KEY: optStr,
  PURSER_MODEL: z.preprocess(emptyToUndef, z.string().default("claude-sonnet-5-5")),
  PURSER_ADMIN_TOKEN: optStr,
  PUBLIC_URL: z.preprocess(emptyToUndef, z.string().url().default("http://127.0.0.1:8799")),
  PORT: z.preprocess(emptyToUndef, z.coerce.number().int().min(1).max(65535).default(8799)),
  DATABASE_PATH: z.preprocess(emptyToUndef, z.string().default("./data/purser.db")),
  TELEGRAM_BOT_TOKEN: optStr,
  TELEGRAM_CHAT_ID: optStr,
  AGENT_API_KEY: optStr,
  LOG_LEVEL: z.preprocess(emptyToUndef, z.string().default("info")),
});

export type Config = z.infer<typeof EnvSchema>;

/** Validate env vars. Fails closed: throws a readable error (never echoes values). */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(env)"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return parsed.data;
}
