import { POLICY } from "@backstop/config/registry";
import { describe, expect, it } from "vitest";
import { closeTx, setAgentTx, setOnBehalfOfTx, withdrawNearTx } from "@/lib/policy-client";

// Each owner call must match the contract's method name, argument names, deposit and gas floor.
describe("owner transactions match the policy contract", () => {
  it("close takes exactly 1 yocto, no beneficiary argument, and at least the contract's 40 TGas", () => {
    const c = closeTx("alice.backstop.near").calls[0]!;
    expect(c.methodName).toBe("close");
    expect(c.args).toEqual({});
    expect(c.depositYocto).toBe("1");
    expect(c.gasTgas).toBeGreaterThanOrEqual(40);
    expect(c.gasTgas).toBe(POLICY.gas.close);
  });
  it("set_agent, set_on_behalf_of and withdraw_near use the contract's argument names and 1 yocto", () => {
    expect(setAgentTx("p.near", "agent.near").calls[0]).toMatchObject({ methodName: "set_agent", args: { agent: "agent.near" }, depositYocto: "1" });
    expect(setOnBehalfOfTx("p.near", "0xabc").calls[0]).toMatchObject({ methodName: "set_on_behalf_of", args: { on_behalf_of: "0xabc" }, depositYocto: "1" });
    expect(withdrawNearTx("p.near", 5n).calls[0]).toMatchObject({ methodName: "withdraw_near", args: { amount: "5" }, depositYocto: "1" });
  });
});
