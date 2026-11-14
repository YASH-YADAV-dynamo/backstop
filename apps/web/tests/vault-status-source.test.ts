import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureRow, parseRow, readVaultStatus } from "@/lib/vault-status-source";

afterEach(() => vi.unstubAllEnvs());
const ID = "base-1.vaults.backstop.near";

describe("readVaultStatus", () => {
  it("returns no row when the bot has written none (shown as Not watched)", async () => {
    expect(await readVaultStatus(ID)).toEqual({ status: null, ageMs: null });
  });
  it("returns the row and its age by the server's clock", async () => {
    vi.stubEnv("BACKSTOP_VAULT_STATUS_FIXTURE", "watching");
    const r = await readVaultStatus(ID, 1_000_000);
    expect(r.status?.state).toBe("watching");
    expect(r.ageMs).toBe(20_000);
  });
  it("never serves the fixture in production", async () => {
    vi.stubEnv("BACKSTOP_VAULT_STATUS_FIXTURE", "watching");
    vi.stubEnv("NODE_ENV", "production");
    expect(await readVaultStatus(ID)).toEqual({ status: null, ageMs: null });
  });
});

describe("parseRow", () => {
  it("drops a row it cannot understand, so the vault shows as Not watched", () => {
    const bad = { ...(fixtureRow("watching", ID, 5) as object), readiness: { funds: "great", gas: "ok", debt: "usdc" } };
    expect(parseRow(bad, ID, 10)).toEqual({ status: null, ageMs: null });
    expect(parseRow("nonsense", ID, 10)).toEqual({ status: null, ageMs: null });
  });
  it("drops a row that belongs to another vault", () => {
    expect(parseRow(fixtureRow("watching", "other.near", 5), ID, 10)).toEqual({ status: null, ageMs: null });
  });
  it("accepts ISO and millisecond times", () => {
    const iso = { ...(fixtureRow("watching", ID, 5) as object), checkedAt: "2026-11-14T10:00:00Z" };
    expect(parseRow(iso, ID, Date.parse("2026-11-14T10:00:30Z")).ageMs).toBe(30_000);
  });
});
