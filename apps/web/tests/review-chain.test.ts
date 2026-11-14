import { chainAddressUrl } from "@backstop/config/registry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";
import type { PolicySnapshot } from "@/lib/policy-client";
import { arbitrumChain, baseChain, DERIVED, OWNER, snapshotFor } from "./fixtures/policy";

let current: PolicySnapshot;

vi.mock("@/lib/loan-client", () => ({
  readEthBalance: vi.fn(async () => 10n * 10n ** 18n),
  readLoan: vi.fn(),
}));
vi.mock("@/lib/policy-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/policy-client")>()),
  readPolicy: vi.fn(async () => current),
  readExpectedCodeHash: vi.fn(async () => null),
}));

const { prepareFundSend, prepareGasTopUp } = await import("@/lib/review");

const wallet = (chainId: number) => ({ address: getAddress("0x3333333333333333333333333333333333333333"), chainId });

beforeEach(() => {
  current = snapshotFor(arbitrumChain);
});

describe("EVM reviews are bound to the policy's chain", () => {
  it("gas send refuses a wallet on another chain", async () => {
    const r = await prepareGasTopUp(current.policyId, OWNER, wallet(baseChain.chainId), "0.001");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("Your wallet is not on Arbitrum One");
  });

  it("gas send review names the policy's chain and links its explorer", async () => {
    const r = await prepareGasTopUp(current.policyId, OWNER, wallet(arbitrumChain.chainId), "0.001");
    expect(r.ok).toBe(true);
    if (!r.ok || r.network !== "evm") throw new Error("expected an EVM review");
    expect(r.chainId).toBe(arbitrumChain.chainId);
    expect(r.rows).toContainEqual(["Network", "Arbitrum One (chain id 42161)"]);
    expect(r.rows).toContainEqual(["Explorer", chainAddressUrl(arbitrumChain, getAddress(DERIVED))]);
    expect(r.rows.find(([k]) => k.startsWith("To"))?.[0]).toContain("Arbitrum One");
  });

  it("op-stack chain note mentions the L1 data fee, Arbitrum note does not", async () => {
    const note = async (snap: PolicySnapshot, chainId: number) => {
      current = snap;
      const r = await prepareGasTopUp(snap.policyId, OWNER, wallet(chainId), "0.001");
      if (!r.ok) throw new Error(r.reason);
      return r.notes.join(" ");
    };
    const onBase = await note(snapshotFor(baseChain), baseChain.chainId);
    const onArb = await note(snapshotFor(arbitrumChain), arbitrumChain.chainId);
    expect(onBase).toContain("L1 data fee (Base posts data to Ethereum)");
    expect(onArb).not.toContain("L1 data fee");
    expect(onArb).toContain("already inside the gas price on Arbitrum One");
  });

  it("fund send refuses a wallet on another chain", async () => {
    const r = await prepareFundSend(wallet(baseChain.chainId), {
      chainId: 1,
      chainName: "Ethereum",
      symbol: "USDC",
      decimals: 6,
      contract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      depositAddress: "0x4444444444444444444444444444444444444444",
      amount: 1_000_000n,
      deadline: new Date(Date.now() + 3_600_000).toISOString(),
      policyId: current.policyId,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("Your wallet is not on Ethereum");
  });

  it("owner reviews of a policy name its loan chain", async () => {
    const { preparePause } = await import("@/lib/review");
    const r = await preparePause(current.policyId, OWNER);
    if (!r.ok) throw new Error(r.reason);
    expect(r.rows).toContainEqual(["Loan chain", "Arbitrum One"]);
  });
});
