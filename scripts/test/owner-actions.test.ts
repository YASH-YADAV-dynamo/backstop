import { describe, expect, it } from "vitest";
import { ONE_CLICK } from "@backstop/config";
import { DEFAULT_LIMITS } from "../src/lib/limits.js";
import { nearCliAgentKey, nearCliCall, shellQuote } from "../src/lib/near-cli.js";
import { ownerAction } from "../src/lib/owner-actions.js";

const p = (action: string, extra: Partial<Parameters<typeof ownerAction>[0]> = {}) => ({ action, arg: undefined, limitFlags: {}, ...extra });

describe("owner actions (printed, never signed)", () => {
  it("pause needs no deposit; every other setter attaches exactly 1 yoctoNEAR", () => {
    expect(ownerAction(p("pause"))).toMatchObject({ method: "pause", depositYocto: 0n });
    expect(ownerAction(p("unpause"))).toMatchObject({ method: "unpause", depositYocto: 1n });
    expect(ownerAction(p("set-agent", { arg: "agent2.near" }))).toMatchObject({ method: "set_agent", args: { agent: "agent2.near" }, depositYocto: 1n });
    expect(ownerAction(p("set-borrower", { arg: "0x000000000000000000000000000000000000beef" }))).toMatchObject({
      method: "set_on_behalf_of",
      args: { on_behalf_of: "0x000000000000000000000000000000000000bEEF" },
    });
    expect(ownerAction(p("set-bridge-signer", { arg: ONE_CLICK.managerPublicKey }))).toMatchObject({
      method: "set_bridge_signer",
      args: { public_key: ONE_CLICK.managerPublicKey },
    });
  });

  it("converts withdraw amounts to contract units", () => {
    expect(ownerAction(p("withdraw", { usdc: "1.5" }))).toMatchObject({ method: "withdraw", args: { amount: "1500000" }, tgas: 50 });
    expect(ownerAction(p("withdraw-near", { near: "0.1" }))).toMatchObject({ method: "withdraw_near", args: { amount: (10n ** 23n).toString() } });
    expect(() => ownerAction(p("withdraw"))).toThrow(/--usdc/);
    expect(() => ownerAction(p("withdraw", { usdc: "0" }))).toThrow(/> 0/);
  });

  it("set-limits starts from the on-chain limits and validates like the contract", () => {
    const call = ownerAction(p("set-limits", { limitFlags: { "max-per-rescue": "2" } }), { ...DEFAULT_LIMITS, paused: false });
    expect(call.args).toEqual({ limits: { ...DEFAULT_LIMITS, max_per_rescue: "2000000" } });
    expect(() => ownerAction(p("set-limits", { limitFlags: { "max-per-rescue": "20" } }), DEFAULT_LIMITS)).toThrow(/DAILY_CAP/);
  });

  it("rejects bad arguments and unknown actions", () => {
    expect(() => ownerAction(p("set-agent", { arg: "Bad" }))).toThrow(/NEAR account id/);
    expect(() => ownerAction(p("set-borrower", { arg: "0x12" }))).toThrow(/0x EVM address/);
    expect(() => ownerAction(p("set-bridge-signer", { arg: "ed25519:short" }))).toThrow(/ed25519/);
    expect(() => ownerAction(p("drain"))).toThrow(/Usage/);
  });
});

describe("near-cli-rs commands", () => {
  it("prints a full call-function command signed by the owner", () => {
    const cmd = nearCliCall({ contractId: "alice.backstop.near", signer: "alice.near", method: "set_agent", args: { agent: "a.near" }, tgas: 30, depositYocto: 1n });
    expect(cmd).toBe(
      "near contract call-function as-transaction alice.backstop.near set_agent \\\n" +
        `    json-args '{"agent":"a.near"}' \\\n` +
        "    prepaid-gas '30 TGas' attached-deposit '1 yoctoNEAR' \\\n" +
        "    sign-as alice.near network-config mainnet sign-with-keychain send",
    );
  });

  it("quotes single quotes for the shell", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it("limits the agent key to the three agent methods on one policy", () => {
    const cmd = nearCliAgentKey("agent.near", "alice.backstop.near", ["rescue", "fund_bridge", "approve_pool"], "ed25519:abc");
    expect(cmd).toContain("--contract-account-id alice.backstop.near");
    expect(cmd).toContain("--function-names 'rescue, fund_bridge, approve_pool'");
  });
});
