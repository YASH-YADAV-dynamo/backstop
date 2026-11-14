/**
 * Vault creation requests (`vault_requests`, one per vault account). The web inserts a request after the
 * user's wallet created the vault account (POST /api/vaults); the bot service deploys the policy into it
 * and moves the request through the state machine below. Postgres when DATABASE_URL is set, else a JSON
 * file at VAULT_REQUESTS_FILE (one process at a time: the web and the bot on one host share the file
 * without a cross-process lock, so production uses Postgres). Every row is zod-validated on write and read.
 *
 *   pending ──> deploying ──> ready
 *      │            │  └────> failed   (gave up; nothing could be returned automatically)
 *      └────────────┴───────> aborted  (the vault account was deleted and its NEAR sent to the owner)
 */
import { isVaultName, SALT_RE, type LimitsJson } from "@backstop/core";
import { readFile } from "node:fs/promises";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.js";
import { createTableSql } from "./ddl.js";
import { vaultRequests, type VaultRequestRow } from "./schema.js";

export const VAULT_REQUEST_STATUSES = ["pending", "deploying", "ready", "failed", "aborted"] as const;
export type VaultRequestStatus = (typeof VAULT_REQUEST_STATUSES)[number];

/** What the web submits: the fields the vault name commits to. */
export interface NewVaultRequest {
  vaultId: string;
  owner: string;
  chainKey: string;
  borrower: string;
  limits: LimitsJson;
  salt: string;
}

export interface VaultRequest extends NewVaultRequest {
  status: VaultRequestStatus;
  attempts: number;
  /** Why the last attempt failed (never a key). */
  lastError: string | null;
  /** ISO 8601 */
  createdAt: string;
  /** ISO 8601 */
  updatedAt: string;
}

export interface VaultRequestPatch {
  status?: VaultRequestStatus;
  attempts?: number;
  lastError?: string | null;
}

const NEXT: Record<VaultRequestStatus, readonly VaultRequestStatus[]> = {
  pending: ["pending", "deploying", "ready", "failed", "aborted"],
  deploying: ["deploying", "ready", "failed", "aborted"],
  ready: [],
  failed: [],
  aborted: [],
};

/** The state machine: ready, failed and aborted are final. */
export const canTransition = (from: VaultRequestStatus, to: VaultRequestStatus): boolean => NEXT[from].includes(to);

const uintString = z.string().regex(/^(0|[1-9]\d*)$/, "expected a decimal integer string");
const uint = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const limitsJsonSchema = z
  .object({
    trigger_hf_bps: uint,
    target_hf_bps: uint,
    max_per_rescue: uintString,
    daily_cap: uintString,
    cooldown_secs: uint,
    max_fee_per_gas: uintString,
    max_gas_limit: uintString,
  })
  .strict();

const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "expected an ISO 8601 date");
/** NEAR account id rules (nomicon): 2-64 chars, lowercase parts separated by `.`, `-` or `_`. */
const nearAccount = z
  .string()
  .min(2)
  .max(64)
  .regex(/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/, "expected a NEAR account id");

export const newVaultRequestSchema = z
  .object({
    vaultId: z.string().refine(isVaultName, "expected a vault name like bkst-<20 hex>.near"),
    owner: nearAccount,
    chainKey: z.string().regex(/^[a-z]{1,32}$/, "expected a loan chain key"),
    borrower: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected a 0x address"),
    limits: limitsJsonSchema,
    salt: z.string().regex(SALT_RE, "expected 32 lowercase hex characters"),
  })
  .strict();

export const vaultRequestSchema = newVaultRequestSchema
  .extend({
    status: z.enum(VAULT_REQUEST_STATUSES),
    attempts: uint,
    lastError: z.string().max(1000).nullable(),
    createdAt: isoDate,
    updatedAt: isoDate,
  })
  .strict();

export function parseVaultRequest(value: unknown, where: string): VaultRequest {
  const parsed = vaultRequestSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`Invalid vault request in ${where}: ${issues}`);
  }
  return parsed.data;
}

/** Same vault id, different fields: the second submission is not the request that created the account. */
export class VaultRequestConflictError extends Error {
  constructor(vaultId: string) {
    super(`A different request for ${vaultId} already exists. Reload the page to see your vault.`);
    this.name = "VaultRequestConflictError";
  }
}

const sameFields = (a: NewVaultRequest, b: NewVaultRequest) =>
  a.vaultId === b.vaultId &&
  a.owner === b.owner &&
  a.chainKey === b.chainKey &&
  a.borrower === b.borrower &&
  a.salt === b.salt &&
  JSON.stringify(limitsJsonSchema.parse(a.limits)) === JSON.stringify(limitsJsonSchema.parse(b.limits));

function fresh(req: NewVaultRequest, now: Date): VaultRequest {
  const at = now.toISOString();
  return parseVaultRequest({ ...req, status: "pending", attempts: 0, lastError: null, createdAt: at, updatedAt: at }, "insert");
}

function patched(cur: VaultRequest, patch: VaultRequestPatch, now: Date): VaultRequest {
  const status = patch.status ?? cur.status;
  if (!canTransition(cur.status, status)) {
    throw new Error(`Vault request ${cur.vaultId} is ${cur.status}; it cannot become ${status}.`);
  }
  return parseVaultRequest(
    {
      ...cur,
      status,
      attempts: patch.attempts ?? cur.attempts,
      lastError: patch.lastError === undefined ? cur.lastError : patch.lastError === null ? null : patch.lastError.slice(0, 1000),
      updatedAt: now.toISOString(),
    },
    `update(${cur.vaultId})`,
  );
}

/** Read side (the web's GET /api/vaults). */
export interface VaultRequestReader {
  get(vaultId: string): Promise<VaultRequest | null>;
  /** Oldest first. */
  listByOwner(owner: string): Promise<VaultRequest[]>;
  /** Requests the bot still has to work on (pending or deploying), oldest first. */
  listPending(): Promise<VaultRequest[]>;
  /** Vaults the bot deployed and admitted (bot discovery). */
  listReady(): Promise<VaultRequest[]>;
  close(): Promise<void>;
}

export interface VaultRequestStore extends VaultRequestReader {
  /**
   * Inserts a pending request unless one exists for the vault id. The same request twice returns the
   * stored row (`inserted: false`); different fields under the same id throw VaultRequestConflictError.
   */
  insertIfAbsent(req: NewVaultRequest, now: Date): Promise<{ request: VaultRequest; inserted: boolean }>;
  /** Applies a status / attempts / error change; throws on a transition the state machine forbids. */
  update(vaultId: string, patch: VaultRequestPatch, now: Date): Promise<VaultRequest>;
}

const byCreated = (a: VaultRequest, b: VaultRequest) => a.createdAt.localeCompare(b.createdAt) || a.vaultId.localeCompare(b.vaultId);
const isOpen = (r: VaultRequest) => r.status === "pending" || r.status === "deploying";

export class JsonVaultRequestStore implements VaultRequestStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly filePath: string) {}

  async get(vaultId: string): Promise<VaultRequest | null> {
    return (await this.read()).find((r) => r.vaultId === vaultId) ?? null;
  }

  async listByOwner(owner: string): Promise<VaultRequest[]> {
    return (await this.read()).filter((r) => r.owner === owner).sort(byCreated);
  }

  async listPending(): Promise<VaultRequest[]> {
    return (await this.read()).filter(isOpen).sort(byCreated);
  }

  async listReady(): Promise<VaultRequest[]> {
    return (await this.read()).filter((r) => r.status === "ready").sort(byCreated);
  }

  async insertIfAbsent(req: NewVaultRequest, now: Date): Promise<{ request: VaultRequest; inserted: boolean }> {
    const row = fresh(req, now);
    return this.write<{ request: VaultRequest; inserted: boolean }>((all) => {
      const cur = all.get(row.vaultId);
      if (cur) {
        if (!sameFields(cur, row)) throw new VaultRequestConflictError(row.vaultId);
        return { result: { request: cur, inserted: false } };
      }
      all.set(row.vaultId, row);
      return { result: { request: row, inserted: true }, changed: true };
    });
  }

  async update(vaultId: string, patch: VaultRequestPatch, now: Date): Promise<VaultRequest> {
    return this.write((all) => {
      const cur = all.get(vaultId);
      if (!cur) throw new Error(`No vault request for ${vaultId}.`);
      const next = patched(cur, patch, now);
      all.set(vaultId, next);
      return { result: next, changed: true };
    });
  }

  async close(): Promise<void> {
    await this.queue.catch(() => undefined);
  }

  /** Read-modify-write under this process's queue; the file is rewritten atomically only when something changed. */
  private write<T>(fn: (all: Map<string, VaultRequest>) => { result: T; changed?: boolean }): Promise<T> {
    const run = this.queue.then(async () => {
      const all = new Map((await this.read()).map((r) => [r.vaultId, r]));
      const { result, changed } = fn(all);
      if (changed) await writeFileAtomic(this.filePath, JSON.stringify([...all.values()].sort(byCreated), null, 2) + "\n");
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async read(): Promise<VaultRequest[]> {
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
      throw new Error(`${this.filePath} is not valid JSON. Fix or restore it: it lists vaults that are being created.`);
    }
    if (!Array.isArray(data)) throw new Error(`${this.filePath} must hold a JSON array of vault requests. Fix or restore it.`);
    return data.map((v, i) => parseVaultRequest(v, `${this.filePath}[${i}]`));
  }
}

export function toRequestRow(r: VaultRequest): VaultRequestRow {
  return {
    vaultId: r.vaultId,
    owner: r.owner,
    chainKey: r.chainKey,
    borrower: r.borrower,
    limitsJson: JSON.stringify(r.limits),
    salt: r.salt,
    status: r.status,
    attempts: r.attempts,
    lastError: r.lastError,
    createdAt: new Date(r.createdAt),
    updatedAt: new Date(r.updatedAt),
  };
}

export function fromRequestRow(row: VaultRequestRow): VaultRequest {
  let limits: unknown;
  try {
    limits = JSON.parse(row.limitsJson);
  } catch {
    limits = null;
  }
  return parseVaultRequest(
    {
      vaultId: row.vaultId,
      owner: row.owner,
      chainKey: row.chainKey,
      borrower: row.borrower,
      limits,
      salt: row.salt,
      status: row.status,
      attempts: row.attempts,
      lastError: row.lastError,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    },
    `vault_requests row ${row.vaultId}`,
  );
}

export class PostgresVaultRequestStore implements VaultRequestStore {
  private constructor(
    private readonly client: postgres.Sql,
    private readonly db: PostgresJsDatabase,
  ) {}

  /** Both the web (insert) and the bot (update) write this table, so both may create it. */
  static async open(databaseUrl: string): Promise<PostgresVaultRequestStore> {
    const client = postgres(databaseUrl, { max: 2, onnotice: () => undefined });
    try {
      await client.unsafe(createTableSql(vaultRequests));
    } catch (err) {
      await client.end({ timeout: 5 });
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Could not create the vault_requests table (${reason}). Check DATABASE_URL.`);
    }
    return new PostgresVaultRequestStore(client, drizzle(client));
  }

  async get(vaultId: string): Promise<VaultRequest | null> {
    const [row] = await this.db.select().from(vaultRequests).where(eq(vaultRequests.vaultId, vaultId));
    return row ? fromRequestRow(row) : null;
  }

  async listByOwner(owner: string): Promise<VaultRequest[]> {
    const rows = await this.db.select().from(vaultRequests).where(eq(vaultRequests.owner, owner)).orderBy(vaultRequests.createdAt, vaultRequests.vaultId);
    return rows.map(fromRequestRow);
  }

  async listPending(): Promise<VaultRequest[]> {
    const rows = await this.db
      .select()
      .from(vaultRequests)
      .where(inArray(vaultRequests.status, ["pending", "deploying"]))
      .orderBy(vaultRequests.createdAt, vaultRequests.vaultId);
    return rows.map(fromRequestRow);
  }

  async listReady(): Promise<VaultRequest[]> {
    const rows = await this.db.select().from(vaultRequests).where(eq(vaultRequests.status, "ready")).orderBy(vaultRequests.createdAt, vaultRequests.vaultId);
    return rows.map(fromRequestRow);
  }

  async insertIfAbsent(req: NewVaultRequest, now: Date): Promise<{ request: VaultRequest; inserted: boolean }> {
    const row = fresh(req, now);
    const inserted = await this.db.insert(vaultRequests).values(toRequestRow(row)).onConflictDoNothing({ target: vaultRequests.vaultId }).returning({ id: vaultRequests.vaultId });
    if (inserted.length > 0) return { request: row, inserted: true };
    const cur = await this.get(row.vaultId);
    if (!cur) throw new Error(`Vault request ${row.vaultId} vanished while inserting. Retry.`);
    if (!sameFields(cur, row)) throw new VaultRequestConflictError(row.vaultId);
    return { request: cur, inserted: false };
  }

  async update(vaultId: string, patch: VaultRequestPatch, now: Date): Promise<VaultRequest> {
    const cur = await this.get(vaultId);
    if (!cur) throw new Error(`No vault request for ${vaultId}.`);
    const next = toRequestRow(patched(cur, patch, now));
    // Compare-and-set on the status read above, so a concurrent change is never silently overwritten.
    const done = await this.db
      .update(vaultRequests)
      .set({ status: next.status, attempts: next.attempts, lastError: next.lastError, updatedAt: next.updatedAt })
      .where(and(eq(vaultRequests.vaultId, vaultId), eq(vaultRequests.status, cur.status), eq(vaultRequests.attempts, cur.attempts)))
      .returning({ id: vaultRequests.vaultId });
    if (done.length === 0) throw new Error(`Vault request ${vaultId} changed while updating it. It is retried on the next pass.`);
    return fromRequestRow(next);
  }

  async close(): Promise<void> {
    await this.client.end({ timeout: 5 });
  }
}

type RequestEnv = { DATABASE_URL?: string | undefined; VAULT_REQUESTS_FILE: string };

/** For the bot service and the web API: Postgres (creates the table if needed) or the JSON file. */
export async function openVaultRequestStore(env: RequestEnv): Promise<VaultRequestStore> {
  if (env.DATABASE_URL) return PostgresVaultRequestStore.open(env.DATABASE_URL);
  return new JsonVaultRequestStore(env.VAULT_REQUESTS_FILE);
}
