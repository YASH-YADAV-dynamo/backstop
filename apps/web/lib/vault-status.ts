/**
 * The bot's heartbeat for one vault (v3 section 1.2). The bot writes one row per vault every pass; the web only reads it.
 * "Protected" is shown only from a row that is fresh and says funds, gas and debt are all fine. Pure: no network.
 */
import { z } from "zod";

/** A row older than this means the bot is not watching (two 30 s passes plus slack). */
export const FRESH_MS = 120_000;

const level = z.enum(["ok", "low", "empty"]);

export const vaultStatusSchema = z.object({
  policyId: z.string(),
  chainId: z.number().int(),
  /** ISO time or epoch milliseconds of the bot's last completed check. */
  checkedAt: z.union([z.string(), z.number()]).transform((v, ctx) => {
    const ms = typeof v === "number" ? v : Date.parse(v);
    if (!Number.isFinite(ms)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "checkedAt is not a time" });
    return ms;
  }),
  state: z.enum(["watching", "rescuing", "blocked", "refused"]),
  reason: z.string().nullable().optional(),
  /** 1e18-scaled decimal string, or null when there is no debt. */
  hf: z.string().regex(/^\d+$/).nullable(),
  readiness: z.object({ funds: level, gas: level, debt: z.enum(["usdc", "none", "other"]) }),
});

export type VaultStatus = z.infer<typeof vaultStatusSchema>;

/** The API answer: the row (if any) and how old it is by the server's clock, so a skewed browser clock cannot fake freshness. */
export const vaultStatusResponseSchema = z.object({
  status: vaultStatusSchema.nullable(),
  ageMs: z.number().nullable(),
});
export type VaultStatusResponse = z.infer<typeof vaultStatusResponseSchema>;

export const isFresh = (ageMs: number | null): boolean => ageMs !== null && ageMs >= 0 && ageMs < FRESH_MS;

/** Health as a number from the bot's 1e18-scaled string; null = no debt. */
export const statusHf = (s: VaultStatus): number | null => (s.hf === null ? null : Number(BigInt(s.hf)) / 1e18);
