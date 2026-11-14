/**
 * Bot status rows (`vault_status`, one per vault). The bot service upserts every vault every pass;
 * the web reads them through `openVaultStatusReader` (GET /api/vault-status). Postgres when
 * DATABASE_URL is set, else a JSON file at VAULT_STATUS_FILE. Every row is zod-validated on write and
 * on read, so the web never renders a malformed status.
 */
import type { VaultStatus } from "@backstop/core";
import { readFile } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.js";
import { createTableSql } from "./ddl.js";
import { vaultStatus, type VaultStatusRow } from "./schema.js";

const intString = z.string().regex(/^\d+$/, "expected a non-negative integer string");
const readiness = z.enum(["ok", "low", "empty"]);

export const vaultStatusSchema = z
  .object({
    policyId: z.string().min(2).max(64),
    chainId: z.number().int().positive().nullable(),
    checkedAt: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "expected an ISO 8601 date"),
    state: z.enum(["watching", "rescuing", "blocked", "refused"]),
    reason: z
      .enum([
        "UNREADABLE",
        "NOT_ACTIVATED",
        "HAS_ACCESS_KEYS",
        "AGENT_MISMATCH",
        "CODE_HASH_MISMATCH",
        "CONFIG_MISMATCH",
        "DUPLICATE_RESCUE_WALLET",
        "DEBT_NOT_USDC",
        "PAUSED",
        "NO_FUNDS",
        "NO_GAS",
        "LIMIT_REACHED",
        "READ_FAILED",
        "RESCUE_FAILED",
      ])
      .nullable(),
    lastError: z.string().max(1000).nullable(),
    hf: z.string().regex(/^\d+\.\d{4}$/, "expected a health factor like 1.2345").nullable(),
    usdc: intString,
    usdcWallet: intString,
    gasWei: intString,
    debt: intString,
    readiness: z.object({ funds: readiness, gas: readiness, debt: z.enum(["usdc", "none", "other"]) }).strict(),
  })
  .strict();

export function parseVaultStatus(value: unknown, where: string): VaultStatus {
  const parsed = vaultStatusSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`Invalid vault status in ${where}: ${issues}`);
  }
  return parsed.data as VaultStatus;
}

/** Read side, for the web. */
export interface VaultStatusReader {
  /** The row for one vault, or null when the bot has never checked it. */
  get(policyId: string): Promise<VaultStatus | null>;
  /** Every row, by vault id. */
  list(): Promise<VaultStatus[]>;
  close(): Promise<void>;
}

/** Write side, for the bot service. */
export interface VaultStatusStore extends VaultStatusReader {
  /** Inserts or replaces each row (keyed by policyId). */
  upsert(rows: readonly VaultStatus[]): Promise<void>;
}

const byId = (a: VaultStatus, b: VaultStatus) => (a.policyId < b.policyId ? -1 : a.policyId > b.policyId ? 1 : 0);

export class JsonVaultStatusStore implements VaultStatusStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly filePath: string) {}

  async get(policyId: string): Promise<VaultStatus | null> {
    return (await this.read()).find((r) => r.policyId === policyId) ?? null;
  }

  async list(): Promise<VaultStatus[]> {
    return (await this.read()).sort(byId);
  }

  async upsert(rows: readonly VaultStatus[]): Promise<void> {
    const valid = rows.map((r, i) => parseVaultStatus(r, `upsert()[${i}]`));
    const run = this.queue.then(async () => {
      const all = new Map((await this.read()).map((r) => [r.policyId, r]));
      for (const r of valid) all.set(r.policyId, r);
      await writeFileAtomic(this.filePath, JSON.stringify([...all.values()].sort(byId), null, 2) + "\n");
    });
    this.queue = run.catch(() => undefined);
    await run;
  }

  async close(): Promise<void> {
    await this.queue.catch(() => undefined);
  }

  private async read(): Promise<VaultStatus[]> {
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    if (!text.trim()) return [];
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`${this.filePath} is not valid JSON. Delete it: the bot rewrites it on its next pass.`);
    }
    if (!Array.isArray(data)) throw new Error(`${this.filePath} must hold a JSON array of vault status rows. Delete it.`);
    return data.map((v, i) => parseVaultStatus(v, `${this.filePath}[${i}]`));
  }
}

export function toStatusRow(s: VaultStatus): VaultStatusRow {
  return {
    vaultId: s.policyId,
    chainId: s.chainId,
    lastCheckedAt: new Date(s.checkedAt),
    state: s.state,
    reason: s.reason,
    lastError: s.lastError,
    hf: s.hf,
    usdc: s.usdc,
    usdcWallet: s.usdcWallet,
    gasEth: s.gasWei,
    debt: s.debt,
    readiness: s.readiness,
  };
}

export function fromStatusRow(row: VaultStatusRow): VaultStatus {
  return parseVaultStatus(
    {
      policyId: row.vaultId,
      chainId: row.chainId,
      checkedAt: row.lastCheckedAt.toISOString(),
      state: row.state,
      reason: row.reason,
      lastError: row.lastError,
      hf: row.hf,
      usdc: row.usdc,
      usdcWallet: row.usdcWallet,
      gasWei: row.gasEth,
      debt: row.debt,
      readiness: row.readiness,
    },
    `vault_status row ${row.vaultId}`,
  );
}

/** Postgres "relation does not exist": the bot has not created the table yet, so there are no rows. */
const isMissingTable = (err: unknown) => (err as { code?: string } | null)?.code === "42P01";

export class PostgresVaultStatusStore implements VaultStatusStore {
  private constructor(
    private readonly client: postgres.Sql,
    private readonly db: PostgresJsDatabase,
  ) {}

  /** `createTable`: the bot creates the table; the web reader never runs DDL. */
  static async open(databaseUrl: string, opts: { createTable: boolean }): Promise<PostgresVaultStatusStore> {
    const client = postgres(databaseUrl, { max: 2, onnotice: () => undefined });
    if (opts.createTable) {
      try {
        await client.unsafe(createTableSql(vaultStatus));
      } catch (err) {
        await client.end({ timeout: 5 });
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`Could not create the vault_status table (${reason}). Check DATABASE_URL in .env.`);
      }
    }
    return new PostgresVaultStatusStore(client, drizzle(client));
  }

  async get(policyId: string): Promise<VaultStatus | null> {
    try {
      const [row] = await this.db.select().from(vaultStatus).where(eq(vaultStatus.vaultId, policyId));
      return row ? fromStatusRow(row) : null;
    } catch (err) {
      if (isMissingTable(err)) return null;
      throw err;
    }
  }

  async list(): Promise<VaultStatus[]> {
    try {
      const rows = await this.db.select().from(vaultStatus).orderBy(vaultStatus.vaultId);
      return rows.map(fromStatusRow);
    } catch (err) {
      if (isMissingTable(err)) return [];
      throw err;
    }
  }

  async upsert(rows: readonly VaultStatus[]): Promise<void> {
    if (rows.length === 0) return;
    const values = rows.map((r, i) => toStatusRow(parseVaultStatus(r, `upsert()[${i}]`)));
    const excluded = (col: string) => sql.raw(`excluded."${col}"`);
    await this.db
      .insert(vaultStatus)
      .values(values)
      .onConflictDoUpdate({
        target: vaultStatus.vaultId,
        set: {
          chainId: excluded("chain_id"),
          lastCheckedAt: excluded("last_checked_at"),
          state: excluded("state"),
          reason: excluded("reason"),
          lastError: excluded("last_error"),
          hf: excluded("hf"),
          usdc: excluded("usdc"),
          usdcWallet: excluded("usdc_wallet"),
          gasEth: excluded("gas_eth"),
          debt: excluded("debt"),
          readiness: excluded("readiness"),
        },
      });
  }

  async close(): Promise<void> {
    await this.client.end({ timeout: 5 });
  }
}

type StatusEnv = { DATABASE_URL?: string | undefined; VAULT_STATUS_FILE: string };

/** For the bot service: creates the Postgres table if needed. */
export async function openVaultStatusStore(env: StatusEnv): Promise<VaultStatusStore> {
  if (env.DATABASE_URL) return PostgresVaultStatusStore.open(env.DATABASE_URL, { createTable: true });
  return new JsonVaultStatusStore(env.VAULT_STATUS_FILE);
}

/** For the web (GET /api/vault-status): read-only, never runs DDL. Pass `loadWebEnv()`. */
export async function openVaultStatusReader(env: StatusEnv): Promise<VaultStatusReader> {
  if (env.DATABASE_URL) return PostgresVaultStatusStore.open(env.DATABASE_URL, { createTable: false });
  return new JsonVaultStatusStore(env.VAULT_STATUS_FILE);
}
