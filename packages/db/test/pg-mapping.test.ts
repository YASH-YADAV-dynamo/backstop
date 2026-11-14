import type { RescueRecord } from "@backstop/core";
import { describe, expect, it } from "vitest";
import { fromRow, toRow } from "../src/pg-store.js";
import { addColumnsSql, createTableSql } from "../src/ddl.js";
import { addedColumns, rescues, type RescueRow } from "../src/schema.js";

describe("Postgres row mapping", () => {
  it("round-trips a full record through a row", () => {
    const r: RescueRecord = {
      id: "r1",
      rescueId: 7,
      dryRun: false,
      triggeredAt: "2026-11-12T10:00:00.000Z",
      fundsArrivedAt: "2026-11-12T10:00:25.000Z",
      repayMinedAt: "2026-11-12T10:00:42.000Z",
      hfBefore: 1.24,
      hfAfter: 1.5,
      amount: "3400341",
      status: "success",
      links: { baseRepayTx: "https://basescan.org/tx/0x1" },
      receipt: "Three sentences.",
      policyId: "alice-near.backstop.near",
      borrower: "0x1111222233334444555566667777888899990000",
      signedTx: "0x02f8",
      bridgedIn: "3500000",
    };
    expect(fromRow(toRow(r) as RescueRow)).toEqual(r);
  });

  it("omits null columns instead of returning nulls", () => {
    const r: RescueRecord = { id: "r2", dryRun: true, triggeredAt: "2026-11-12T10:00:00.000Z", hfBefore: 1.2, amount: "1", status: "dry-run", links: {} };
    expect(fromRow(toRow(r) as RescueRow)).toEqual(r);
  });
});

describe("Postgres DDL", () => {
  it("adds the v2 columns to a table created by v1, nullable and idempotent", () => {
    expect(addColumnsSql(rescues, addedColumns)).toEqual([
      'ALTER TABLE "rescues" ADD COLUMN IF NOT EXISTS "policy_id" text',
      'ALTER TABLE "rescues" ADD COLUMN IF NOT EXISTS "borrower" text',
      'ALTER TABLE "rescues" ADD COLUMN IF NOT EXISTS "signed_tx" text',
      'ALTER TABLE "rescues" ADD COLUMN IF NOT EXISTS "bridged_in" text',
    ]);
    expect(createTableSql(rescues)).toContain('"bridged_in" text');
  });

  it("refuses to add a NOT NULL column to existing rows", () => {
    expect(() => addColumnsSql(rescues, ["amount"])).toThrow(/nullable/);
  });
});
