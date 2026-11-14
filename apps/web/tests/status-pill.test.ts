import { describe, expect, it } from "vitest";
import { statusPill, type PillInput } from "@/lib/app-flow";
import { FRESH_MS, type VaultStatus } from "@/lib/vault-status";

const row: VaultStatus = {
  policyId: "base-1.vaults.backstop.near",
  chainId: 8453,
  checkedAt: 0,
  state: "watching",
  hf: String(1_620_000_000_000_000_000n),
  readiness: { funds: "ok", gas: "ok", debt: "usdc" },
};

const ok: PillInput = {
  paused: false,
  status: row,
  statusAgeMs: 20_000,
  usdcEmpty: false,
  gasEmpty: false,
  hf: 1.62,
  text: { trigger: "1.10", chain: "Base", usdc: "20", maxPerRescue: "5" },
};

describe("statusPill (one test per row of the table, first match wins)", () => {
  it("paused_is_grey_and_offers_resume_before_anything_else", () => {
    const p = statusPill({ ...ok, paused: true, status: null, statusAgeMs: null });
    expect([p.id, p.tone, p.action]).toEqual(["paused", "grey", "resume"]);
    expect(p.line).toBe("Rescues are paused. Your loan is not protected.");
  });
  it("rescuing_is_orange_while_the_bot_says_so", () => {
    const p = statusPill({ ...ok, status: { ...row, state: "rescuing" } });
    expect([p.id, p.tone]).toEqual(["rescuing", "orange"]);
  });
  it("no_row_is_not_watched", () => {
    const p = statusPill({ ...ok, status: null, statusAgeMs: null });
    expect([p.id, p.tone, p.action, p.label]).toEqual(["not-watched", "red", "retry", "Not watched"]);
  });
  it("a_refused_or_blocked_vault_is_not_watched", () => {
    expect(statusPill({ ...ok, status: { ...row, state: "refused" } }).id).toBe("not-watched");
    expect(statusPill({ ...ok, status: { ...row, state: "blocked" } }).id).toBe("not-watched");
  });
  it("a_stale_rescuing_row_does_not_show_a_rescue_in_progress", () => {
    expect(statusPill({ ...ok, status: { ...row, state: "rescuing" }, statusAgeMs: FRESH_MS + 1 }).id).toBe("not-watched");
  });
  it("empty_funds_need_usdc_and_say_how_much_one_rescue_can_use", () => {
    const p = statusPill({ ...ok, status: { ...row, readiness: { ...row.readiness, funds: "low" } } });
    expect([p.id, p.tone, p.action]).toEqual(["needs-usdc", "amber", "usdc"]);
    expect(p.line).toBe("Your vault has 20 USDC; one rescue can use up to 5.");
  });
  it("an_exactly_zero_vault_needs_usdc_even_if_the_bot_row_says_ok", () => {
    expect(statusPill({ ...ok, usdcEmpty: true }).id).toBe("needs-usdc");
  });
  it("low_gas_needs_gas", () => {
    expect(statusPill({ ...ok, status: { ...row, readiness: { ...row.readiness, gas: "empty" } } })).toMatchObject({ id: "needs-gas", tone: "amber", action: "gas" });
    expect(statusPill({ ...ok, gasEmpty: true }).id).toBe("needs-gas");
  });
  it("no_debt_is_nothing_to_protect", () => {
    const p = statusPill({ ...ok, status: { ...row, readiness: { ...row.readiness, debt: "none" } }, hf: null });
    expect([p.id, p.tone]).toEqual(["nothing", "grey"]);
    expect(p.line).toBe("No USDC debt on Base right now.");
  });
  it("non_usdc_debt_is_nothing_to_protect_and_says_why", () => {
    const p = statusPill({ ...ok, status: { ...row, readiness: { ...row.readiness, debt: "other" } } });
    expect(p.id).toBe("nothing");
    expect(p.line).toContain("isn't USDC");
  });
  it("health_below_one_is_at_risk_and_links_to_aave", () => {
    const p = statusPill({ ...ok, hf: 0.97 });
    expect([p.id, p.tone, p.action]).toEqual(["at-risk", "red", "aave"]);
  });
  it("at_risk_uses_the_bot_health_when_our_own_read_failed", () => {
    expect(statusPill({ ...ok, hf: undefined, status: { ...row, hf: String(950_000_000_000_000_000n) } }).id).toBe("at-risk");
  });
  it("healthy_with_a_fresh_row_is_protected", () => {
    const p = statusPill(ok);
    expect([p.id, p.tone, p.label]).toEqual(["protected", "green", "Protected"]);
    expect(p.line).toBe("Healthy. Backstop checks every 30 seconds and steps in below 1.10.");
  });
});

describe("protected_requires_a_fresh_bot_heartbeat", () => {
  it("never shows Protected without a row, with an old row, or with an unknown age", () => {
    expect(statusPill({ ...ok, status: null, statusAgeMs: null }).label).not.toBe("Protected");
    expect(statusPill({ ...ok, statusAgeMs: FRESH_MS }).label).not.toBe("Protected");
    expect(statusPill({ ...ok, statusAgeMs: null }).label).not.toBe("Protected");
    expect(statusPill({ ...ok, statusAgeMs: -5 }).label).not.toBe("Protected");
  });
  it("shows Protected only just under two minutes", () => {
    expect(statusPill({ ...ok, statusAgeMs: FRESH_MS - 1 }).label).toBe("Protected");
  });
  it("never shows Protected when funds, gas or debt are not all ok", () => {
    for (const readiness of [
      { funds: "low", gas: "ok", debt: "usdc" },
      { funds: "ok", gas: "empty", debt: "usdc" },
      { funds: "ok", gas: "ok", debt: "none" },
      { funds: "ok", gas: "ok", debt: "other" },
    ] as const) {
      expect(statusPill({ ...ok, status: { ...row, readiness } }).label).not.toBe("Protected");
    }
  });
  it("never shows Protected for a paused vault", () => {
    expect(statusPill({ ...ok, paused: true }).label).not.toBe("Protected");
  });
});
