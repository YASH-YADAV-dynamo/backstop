import { describe, expect, it } from "vitest";
import { appStage, kindLabel, type StageInput } from "@/lib/app-flow";

const ready: StageInput = {
  owner: "alice.near",
  policyId: "alice.backstop.near",
  readError: false,
  loaded: true,
  owned: true,
  verified: true,
  activated: true,
  usdcBalance: 20_000_000n,
  rescueCount: 0,
};

describe("appStage", () => {
  it("shows the connect step until a NEAR account is connected", () => {
    expect(appStage({ ...ready, owner: null })).toBe("connect");
  });
  it("shows the protect step when the account has no vault", () => {
    expect(appStage({ ...ready, policyId: null, loaded: false })).toBe("protect");
  });
  it("shows the protect step while the vault is loading", () => {
    expect(appStage({ ...ready, loaded: false })).toBe("protect");
  });
  it("shows the protect step when the vault cannot be read", () => {
    expect(appStage({ ...ready, readError: true, loaded: false })).toBe("protect");
  });
  it("keeps an owned vault with a failed safety check on the protect step", () => {
    expect(appStage({ ...ready, verified: false })).toBe("protect");
  });
  it("keeps an owned vault without a rescue wallet on the protect step", () => {
    expect(appStage({ ...ready, activated: false })).toBe("protect");
  });
  it("sends someone else's vault to the home screen, whatever its checks say", () => {
    expect(appStage({ ...ready, owned: false })).toBe("home");
    expect(appStage({ ...ready, owned: false, verified: false, activated: false })).toBe("home");
  });
  it("asks for money when an owned, safe, set-up vault is empty and has never rescued", () => {
    expect(appStage({ ...ready, usdcBalance: 0n })).toBe("fund");
  });
  it("goes home once the vault holds USDC", () => {
    expect(appStage(ready)).toBe("home");
  });
  it("goes home when the vault is empty but has rescued before", () => {
    expect(appStage({ ...ready, usdcBalance: 0n, rescueCount: 2 })).toBe("home");
  });
});

describe("kindLabel", () => {
  it("names each journal kind in plain words", () => {
    expect(kindLabel("deposit", "ft_transfer_call")).toBe("Add USDC");
    expect(kindLabel("fund_from_chain", "eth_sendTransaction")).toBe("Deposit from another chain");
  });
  it("falls back to the contract method for an unknown kind", () => {
    expect(kindLabel("mystery", "do_thing")).toBe("do_thing");
  });
});
