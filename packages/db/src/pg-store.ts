/**
 * Rescue records in Postgres via drizzle-orm + postgres-js. The table is created on open
 * (CREATE TABLE IF NOT EXISTS, generated from schema.ts), and columns added since v1 are added
 * with ALTER TABLE ... ADD COLUMN IF NOT EXISTS.
 */
import type { RescueRecord } from "@backstop/core";
import { asc, eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { addColumnsSql, createTableSql } from "./ddl.js";
import { applyPatch, parseRecord, type RescuePatch, type RescueStore } from "./record.js";
import { addedColumns, rescues, type RescueRow } from "./schema.js";

type Insert = typeof rescues.$inferInsert;

const toDate = (iso: string | undefined) => (iso === undefined ? null : new Date(iso));

export function toRow(r: RescueRecord): Insert {
  return {
    id: r.id,
    rescueId: r.rescueId ?? null,
    dryRun: r.dryRun,
    triggeredAt: new Date(r.triggeredAt),
    fundsArrivedAt: toDate(r.fundsArrivedAt),
    repayMinedAt: toDate(r.repayMinedAt),
    hfBefore: r.hfBefore,
    hfAfter: r.hfAfter ?? null,
    amount: r.amount,
    status: r.status,
    links: r.links,
    error: r.error ?? null,
    receipt: r.receipt ?? null,
    receiptSource: r.receiptSource ?? null,
    policyId: r.policyId ?? null,
    borrower: r.borrower ?? null,
    signedTx: r.signedTx ?? null,
    bridgedIn: r.bridgedIn ?? null,
  };
}

export function fromRow(row: RescueRow): RescueRecord {
  const record: Record<string, unknown> = {
    id: row.id,
    dryRun: row.dryRun,
    triggeredAt: row.triggeredAt.toISOString(),
    hfBefore: row.hfBefore,
    amount: row.amount,
    status: row.status,
    links: row.links,
  };
  if (row.rescueId !== null) record.rescueId = row.rescueId;
  if (row.fundsArrivedAt !== null) record.fundsArrivedAt = row.fundsArrivedAt.toISOString();
  if (row.repayMinedAt !== null) record.repayMinedAt = row.repayMinedAt.toISOString();
  if (row.hfAfter !== null) record.hfAfter = row.hfAfter;
  if (row.error !== null) record.error = row.error;
  if (row.receipt !== null) record.receipt = row.receipt;
  if (row.receiptSource === "near-ai" || row.receiptSource === "template") record.receiptSource = row.receiptSource;
  if (row.policyId !== null) record.policyId = row.policyId;
  if (row.borrower !== null) record.borrower = row.borrower;
  if (row.signedTx !== null) record.signedTx = row.signedTx;
  if (row.bridgedIn !== null) record.bridgedIn = row.bridgedIn;
  return parseRecord(record, `rescues row ${row.id}`);
}

export class PostgresStore implements RescueStore {
  private constructor(
    private readonly client: postgres.Sql,
    private readonly db: PostgresJsDatabase,
  ) {}

  /** Connects and creates the rescues table if it does not exist. */
  static async open(databaseUrl: string): Promise<PostgresStore> {
    const client = postgres(databaseUrl, { max: 2, onnotice: () => undefined });
    try {
      await client.unsafe(createTableSql(rescues));
      for (const sql of addColumnsSql(rescues, addedColumns)) await client.unsafe(sql);
    } catch (err) {
      await client.end({ timeout: 5 });
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Could not open the Postgres rescue store (${reason}). Check DATABASE_URL in .env, or unset it to store rescues in the RESCUES_FILE JSON file.`,
      );
    }
    return new PostgresStore(client, drizzle(client));
  }

  async add(r: RescueRecord): Promise<void> {
    const record = parseRecord(r, "add()");
    const inserted = await this.db.insert(rescues).values(toRow(record)).onConflictDoNothing().returning({ id: rescues.id });
    if (inserted.length === 0) throw new Error(`Rescue ${r.id} already exists in Postgres; use update() to change it.`);
  }

  async update(id: string, patch: RescuePatch): Promise<RescueRecord> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(rescues).where(eq(rescues.id, id)).for("update");
      if (!row) throw new Error(`Rescue ${id} not found in Postgres; add() it first.`);
      const next = parseRecord(applyPatch(fromRow(row), patch), `update(${id})`);
      const { id: _id, ...values } = toRow(next);
      await tx.update(rescues).set(values).where(eq(rescues.id, id));
      return next;
    });
  }

  async list(): Promise<RescueRecord[]> {
    const rows = await this.db.select().from(rescues).orderBy(asc(rescues.triggeredAt));
    return rows.map(fromRow);
  }

  async close(): Promise<void> {
    await this.client.end({ timeout: 5 });
  }
}
