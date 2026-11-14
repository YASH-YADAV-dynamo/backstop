/**
 * zod schema for RescueRecord. Every record is validated when added and when read back, so a
 * hand-edited or truncated store fails loudly instead of feeding bad data to the dashboard.
 */
import type { RescueRecord } from "@backstop/core";
import { z } from "zod";

const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "expected an ISO 8601 date");

/** A health factor. Infinity (no debt left) is stored in JSON as the string "Infinity". */
const hf = z.union([z.number(), z.literal("Infinity").transform(() => Number.POSITIVE_INFINITY)]);

const linksSchema = z
  .object({
    oneClickDeposit: z.string().optional(),
    oneClickStatus: z.string().optional(),
    nearRescueTx: z.string().optional(),
    baseRepayTx: z.string().optional(),
    baseFundsTx: z.string().optional(),
  })
  .strict();

export const rescueRecordSchema = z
  .object({
    id: z.string().min(1),
    rescueId: z.number().int().nonnegative().optional(),
    dryRun: z.boolean(),
    triggeredAt: isoDate,
    fundsArrivedAt: isoDate.optional(),
    repayMinedAt: isoDate.optional(),
    hfBefore: hf,
    hfAfter: hf.optional(),
    amount: z.string().regex(/^\d+$/, "amount must be a USDC 6dp integer string"),
    status: z.enum(["success", "failed", "dry-run"]),
    links: linksSchema,
    error: z.string().optional(),
    receipt: z.string().optional(),
    receiptSource: z.enum(["near-ai", "template"]).optional(),
    policyId: z.string().min(1).optional(),
    borrower: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "borrower must be a 0x EVM address").optional(),
    signedTx: z.string().regex(/^0x[0-9a-fA-F]+$/, "signedTx must be 0x hex").optional(),
    bridgedIn: z.string().regex(/^\d+$/, "bridgedIn must be a USDC 6dp integer string").optional(),
  })
  .strict();

export type RescuePatch = Partial<Omit<RescueRecord, "id">>;

export function parseRecord(value: unknown, where: string): RescueRecord {
  const parsed = rescueRecordSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`Invalid rescue record in ${where}: ${issues}`);
  }
  return parsed.data as RescueRecord;
}

/** Merge a patch; `links` are merged key by key so adding one link keeps the others. */
export function applyPatch(r: RescueRecord, patch: RescuePatch): RescueRecord {
  return { ...r, ...patch, id: r.id, links: { ...r.links, ...patch.links } };
}

export interface RescueStore {
  /** Throws if a record with the same id exists. */
  add(r: RescueRecord): Promise<void>;
  /** Throws if the id is unknown. Returns the updated record. */
  update(id: string, patch: RescuePatch): Promise<RescueRecord>;
  /** Oldest first (by triggeredAt). */
  list(): Promise<RescueRecord[]>;
  close(): Promise<void>;
}
