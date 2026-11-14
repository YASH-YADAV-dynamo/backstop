import type { RescueRecord } from "@backstop/core";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTableSql, JsonFileStore, openStore, rescues } from "../src/index.js";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "backstop-db-"));
  file = join(dir, "nested", "rescues.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const rec = (id: string, triggeredAt: string, over: Partial<RescueRecord> = {}): RescueRecord => ({
  id,
  dryRun: true,
  triggeredAt,
  hfBefore: 1.24,
  amount: "3400341",
  status: "dry-run",
  links: {},
  ...over,
});

describe("JsonFileStore", () => {
  it("starts empty when the file does not exist", async () => {
    expect(await new JsonFileStore(file).list()).toEqual([]);
  });

  it("adds, lists oldest first, and persists across instances", async () => {
    const s = new JsonFileStore(file);
    await s.add(rec("b", "2026-11-12T10:05:00.000Z"));
    await s.add(rec("a", "2026-11-12T10:00:00.000Z", { rescueId: 3 }));
    const again = await new JsonFileStore(file).list();
    expect(again.map((r) => r.id)).toEqual(["a", "b"]);
    expect(again[0]!.rescueId).toBe(3);
  });

  it("updates a record and merges links", async () => {
    const s = new JsonFileStore(file);
    await s.add(rec("r1", "2026-11-12T10:00:00.000Z", { links: { oneClickStatus: "https://x/status" } }));
    const next = await s.update("r1", {
      status: "success",
      dryRun: false,
      hfAfter: 1.5,
      links: { baseRepayTx: "https://basescan.org/tx/0x1" },
    });
    expect(next.links).toEqual({ oneClickStatus: "https://x/status", baseRepayTx: "https://basescan.org/tx/0x1" });
    expect((await s.list())[0]).toMatchObject({ status: "success", hfAfter: 1.5 });
  });

  it("round-trips an infinite health factor (all debt repaid)", async () => {
    const s = new JsonFileStore(file);
    await s.add(rec("r1", "2026-11-12T10:00:00.000Z", { hfAfter: Number.POSITIVE_INFINITY }));
    expect((await new JsonFileStore(file).list())[0]!.hfAfter).toBe(Number.POSITIVE_INFINITY);
  });

  it("rejects duplicate ids and unknown updates", async () => {
    const s = new JsonFileStore(file);
    await s.add(rec("r1", "2026-11-12T10:00:00.000Z"));
    await expect(s.add(rec("r1", "2026-11-12T10:00:00.000Z"))).rejects.toThrow(/already exists/);
    await expect(s.update("nope", { status: "failed" })).rejects.toThrow(/not found/);
  });

  it("rejects invalid records before writing", async () => {
    const s = new JsonFileStore(file);
    await expect(s.add(rec("r1", "not a date"))).rejects.toThrow(/triggeredAt/);
    await expect(s.add(rec("r2", "2026-11-12T10:00:00.000Z", { amount: "3.40" }))).rejects.toThrow(/amount/);
    expect(await s.list()).toEqual([]);
  });

  it("serializes concurrent writes without losing records", async () => {
    const s = new JsonFileStore(file);
    await Promise.all(Array.from({ length: 20 }, (_, i) => s.add(rec(`r${i}`, new Date(1_700_000_000_000 + i).toISOString()))));
    expect((await s.list()).length).toBe(20);
  });

  it("writes atomically: no temp files left and the file is always complete JSON", async () => {
    const s = new JsonFileStore(file);
    await s.add(rec("r1", "2026-11-12T10:00:00.000Z"));
    await s.update("r1", { receipt: "Three sentences." });
    expect(await readdir(join(dir, "nested"))).toEqual(["rescues.json"]);
    expect(JSON.parse(await readFile(file, "utf8"))).toHaveLength(1);
  });

  it("explains how to fix a corrupt file", async () => {
    const s = new JsonFileStore(file);
    await s.add(rec("r1", "2026-11-12T10:00:00.000Z"));
    await writeFile(file, "[{", "utf8");
    await expect(s.list()).rejects.toThrow(/not valid JSON. Fix or delete it/);
  });
});

describe("openStore", () => {
  it("uses the JSON file when DATABASE_URL is not set", async () => {
    const s = await openStore({ DATABASE_URL: undefined, RESCUES_FILE: file });
    expect(s).toBeInstanceOf(JsonFileStore);
    await s.close();
  });
});

describe("Postgres schema", () => {
  it("generates CREATE TABLE IF NOT EXISTS from the drizzle schema", () => {
    expect(createTableSql(rescues)).toBe(
      [
        'CREATE TABLE IF NOT EXISTS "rescues" (',
        '  "id" text PRIMARY KEY,',
        '  "rescue_id" integer,',
        '  "dry_run" boolean NOT NULL,',
        '  "triggered_at" timestamp with time zone NOT NULL,',
        '  "funds_arrived_at" timestamp with time zone,',
        '  "repay_mined_at" timestamp with time zone,',
        '  "hf_before" double precision NOT NULL,',
        '  "hf_after" double precision,',
        '  "amount" text NOT NULL,',
        '  "status" text NOT NULL,',
        '  "links" jsonb NOT NULL,',
        '  "error" text,',
        '  "receipt" text,',
        '  "receipt_source" text,',
        '  "policy_id" text,',
        '  "borrower" text,',
        '  "signed_tx" text,',
        '  "bridged_in" text',
        ")",
      ].join("\n"),
    );
  });
});
