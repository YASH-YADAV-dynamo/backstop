/**
 * Invite requests from NEAR accounts that are not on VAULT_ALLOWED_OWNERS yet (`invite_requests`, one row per
 * account; asking again updates the row). Postgres when DATABASE_URL is set, else a JSON file next to
 * VAULT_REQUESTS_FILE. Holds only what the user typed: a NEAR account, an optional rough Aave volume and note.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import postgres from "postgres";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.js";

export const inviteRequestSchema = z.object({
  account: z.string().min(2).max(64),
  /** Rough Aave volume bracket the user picked, e.g. "under-1k"; null when skipped. */
  volume: z.string().max(40).nullable(),
  note: z.string().max(500).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type InviteRequest = z.infer<typeof inviteRequestSchema>;
export type NewInviteRequest = Pick<InviteRequest, "account" | "volume" | "note">;

export interface InviteRequestStore {
  /** Saves or updates the request for `account`; returns the stored row. */
  upsert(req: NewInviteRequest, now: Date): Promise<InviteRequest>;
  get(account: string): Promise<InviteRequest | null>;
}

export class JsonInviteRequestStore implements InviteRequestStore {
  constructor(private readonly file: string) {}

  private async all(): Promise<InviteRequest[]> {
    try {
      return z.array(inviteRequestSchema).parse(JSON.parse(await readFile(this.file, "utf8")));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  async upsert(req: NewInviteRequest, now: Date): Promise<InviteRequest> {
    const rows = await this.all();
    const at = now.toISOString();
    const prev = rows.find((r) => r.account === req.account);
    const row = inviteRequestSchema.parse({ ...req, createdAt: prev?.createdAt ?? at, updatedAt: at });
    await writeFileAtomic(this.file, JSON.stringify([...rows.filter((r) => r.account !== req.account), row], null, 2));
    return row;
  }

  async get(account: string): Promise<InviteRequest | null> {
    return (await this.all()).find((r) => r.account === account) ?? null;
  }
}

type Row = { account: string; volume: string | null; note: string | null; created_at: Date; updated_at: Date };
const fromRow = (r: Row): InviteRequest =>
  inviteRequestSchema.parse({ account: r.account, volume: r.volume, note: r.note, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString() });

export class PostgresInviteRequestStore implements InviteRequestStore {
  private constructor(private readonly sql: postgres.Sql) {}

  static async open(url: string): Promise<PostgresInviteRequestStore> {
    const sql = postgres(url, { max: 2 });
    await sql`CREATE TABLE IF NOT EXISTS invite_requests (
      account text PRIMARY KEY,
      volume text,
      note text,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    )`;
    return new PostgresInviteRequestStore(sql);
  }

  async upsert(req: NewInviteRequest, now: Date): Promise<InviteRequest> {
    const rows = await this.sql<Row[]>`
      INSERT INTO invite_requests (account, volume, note, created_at, updated_at)
      VALUES (${req.account}, ${req.volume}, ${req.note}, ${now}, ${now})
      ON CONFLICT (account) DO UPDATE SET volume = EXCLUDED.volume, note = EXCLUDED.note, updated_at = EXCLUDED.updated_at
      RETURNING account, volume, note, created_at, updated_at`;
    return fromRow(rows[0]!);
  }

  async get(account: string): Promise<InviteRequest | null> {
    const rows = await this.sql<Row[]>`SELECT account, volume, note, created_at, updated_at FROM invite_requests WHERE account = ${account}`;
    return rows[0] ? fromRow(rows[0]) : null;
  }
}

export async function openInviteRequestStore(env: { DATABASE_URL?: string; VAULT_REQUESTS_FILE: string }): Promise<InviteRequestStore> {
  if (env.DATABASE_URL) return PostgresInviteRequestStore.open(env.DATABASE_URL);
  return new JsonInviteRequestStore(join(dirname(env.VAULT_REQUESTS_FILE), "invite-requests.json"));
}
