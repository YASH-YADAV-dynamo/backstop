/**
 * Drizzle schema: the source of truth for the Postgres `rescues` table. Columns mirror
 * RescueRecord; `links` is jsonb. The CREATE TABLE statement is generated from this definition
 * (see ddl.ts), so no migration tool is needed for the demo.
 */
import type { RescueLinks, VaultReadiness } from "@backstop/core";
import { boolean, doublePrecision, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const rescues = pgTable("rescues", {
  id: text("id").primaryKey(),
  rescueId: integer("rescue_id"),
  dryRun: boolean("dry_run").notNull(),
  triggeredAt: ts("triggered_at").notNull(),
  fundsArrivedAt: ts("funds_arrived_at"),
  repayMinedAt: ts("repay_mined_at"),
  hfBefore: doublePrecision("hf_before").notNull(),
  hfAfter: doublePrecision("hf_after"),
  /** USDC 6dp integer string (kept as text so no precision is lost). */
  amount: text("amount").notNull(),
  status: text("status", { enum: ["success", "failed", "dry-run"] }).notNull(),
  links: jsonb("links").$type<RescueLinks>().notNull(),
  error: text("error"),
  receipt: text("receipt"),
  receiptSource: text("receipt_source"),
  policyId: text("policy_id"),
  borrower: text("borrower"),
  signedTx: text("signed_tx"),
  bridgedIn: text("bridged_in"),
});

/** Columns added after the first release; `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` on open. */
export const addedColumns = ["policy_id", "borrower", "signed_tx", "bridged_in"] as const;

export type RescueRow = typeof rescues.$inferSelect;

/**
 * Bot status, one row per vault (design v3 1.2), upserted by the bot service every pass and read by
 * the web (GET /api/vault-status). Amounts are integer strings (USDC 6dp, ETH wei).
 */
export const vaultStatus = pgTable("vault_status", {
  vaultId: text("vault_id").primaryKey(),
  chainId: integer("chain_id"),
  lastCheckedAt: ts("last_checked_at").notNull(),
  state: text("state", { enum: ["watching", "rescuing", "blocked", "refused"] }).notNull(),
  reason: text("reason"),
  lastError: text("last_error"),
  hf: text("hf"),
  usdc: text("usdc").notNull(),
  usdcWallet: text("usdc_wallet").notNull(),
  gasEth: text("gas_eth").notNull(),
  debt: text("debt").notNull(),
  readiness: jsonb("readiness").$type<VaultReadiness>().notNull(),
});

export type VaultStatusRow = typeof vaultStatus.$inferSelect;

/**
 * Factory-less vault creation requests, one per vault account (design: server-signed creation). The
 * web inserts a row after the user's wallet created the account; the bot deploys the policy into it
 * and moves the row to ready, failed or aborted. `limits_json` is the contract's `Limits` JSON.
 */
export const vaultRequests = pgTable("vault_requests", {
  vaultId: text("vault_id").primaryKey(),
  owner: text("owner").notNull(),
  chainKey: text("chain_key").notNull(),
  borrower: text("borrower").notNull(),
  limitsJson: text("limits_json").notNull(),
  salt: text("salt").notNull(),
  status: text("status", { enum: ["pending", "deploying", "ready", "failed", "aborted"] }).notNull(),
  attempts: integer("attempts").notNull(),
  lastError: text("last_error"),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

export type VaultRequestRow = typeof vaultRequests.$inferSelect;
