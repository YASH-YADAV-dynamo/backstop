import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PolicySnapshot } from "@/lib/policy-client";
import { arbitrumChain, baseChain, BORROWER, DERIVED, snapshotFor } from "./fixtures/policy";

let policy: PolicySnapshot;
let records: unknown[] = [];

const readPosition = vi.fn();
const assertChainId = vi.fn(async () => undefined);
const erc20Balance = vi.fn(async () => 7_000_000n);
const getBalance = vi.fn(async () => 3n * 10n ** 15n);
const evmClient = vi.fn(() => ({ getBalance }));

vi.mock("@backstop/chains", () => ({ evmClient, assertChainId, erc20Balance }));
vi.mock("@backstop/lending-aave", () => ({ readPosition }));
vi.mock("@backstop/db", () => ({ openStore: async () => ({ list: async () => records, close: async () => undefined }) }));
vi.mock("@backstop/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@backstop/config")>()),
  loadWebEnv: () => ({ POLICY_CONTRACT_ID: undefined, RESCUES_FILE: "unused", NEAR_RPC_URL: undefined, BASE_RPC_URL: undefined, ARBITRUM_RPC_URL: undefined }),
}));
vi.mock("@/lib/near-rpc", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/near-rpc")>()), configureNearRpc: vi.fn() }));
vi.mock("@/lib/policy-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/policy-client")>()),
  readPolicy: vi.fn(async () => policy),
  readExpectedCodeHash: vi.fn(async () => null),
}));

const { getDashboard } = await import("@/lib/data");

const position = { totalCollateralBase: 100_00000000n, totalDebtBase: 50_00000000n, availableBorrowsBase: 10_00000000n, currentLiquidationThreshold: 8300n, ltv: 8000n, healthFactor: 1_320_000_000_000_000_000n };

beforeEach(() => {
  vi.clearAllMocks();
  readPosition.mockResolvedValue(position);
  assertChainId.mockResolvedValue(undefined);
  policy = snapshotFor(arbitrumChain);
  records = [];
});

describe("the dashboard reads the loan on the policy's chain", () => {
  it("health factor is read for on_behalf_of, not the derived address", async () => {
    const snap = await getDashboard(policy.policyId);
    expect(readPosition).toHaveBeenCalledTimes(1);
    const [, aave, user] = readPosition.mock.calls[0]!;
    expect(user).toBe(BORROWER);
    expect(user).not.toBe(DERIVED);
    expect(aave).toBe(arbitrumChain.aave);
    // Only the balances belong to the derived address.
    expect(erc20Balance).toHaveBeenCalledWith(expect.anything(), arbitrumChain.aave.usdc, DERIVED);
    expect(getBalance).toHaveBeenCalledWith({ address: DERIVED });
    expect(snap.position.state === "ok" && snap.position.data.address).toBe(BORROWER);
    expect(snap.position.state === "ok" && snap.position.data.healthFactor).toBeCloseTo(1.32, 2);
  });

  it("the chain client is the policy's chain and is checked before any read", async () => {
    await getDashboard(policy.policyId);
    expect(evmClient).toHaveBeenCalledWith(arbitrumChain, expect.arrayContaining([...arbitrumChain.rpcUrls]));
    expect(assertChainId.mock.invocationCallOrder[0]!).toBeLessThan(readPosition.mock.invocationCallOrder[0]!);
  });

  it("an RPC that serves another chain becomes an error section and nothing is read", async () => {
    assertChainId.mockRejectedValue(new Error("The Arbitrum One RPC reports chainId 8453, expected 42161 (Arbitrum One). Fix ARBITRUM_RPC_URL in .env."));
    const snap = await getDashboard(policy.policyId);
    expect(snap.position.state).toBe("error");
    if (snap.position.state === "error") {
      expect(snap.position.message).toContain("ARBITRUM_RPC_URL");
      expect(snap.position.message).toContain("8453");
    }
    expect(readPosition).not.toHaveBeenCalled();
  });

  it("an unsupported chain id is an error section naming the supported chains", async () => {
    policy = snapshotFor(baseChain, { chain_id: 1 });
    const snap = await getDashboard(policy.policyId);
    expect(snap.policy.state).toBe("error");
    if (snap.policy.state === "error") expect(snap.policy.message).toContain("Base (8453), Arbitrum One (42161)");
    expect(readPosition).not.toHaveBeenCalled();
  });

  it("repay links use the policy chain explorer", async () => {
    records = [
      { id: "a", dryRun: false, triggeredAt: "2026-11-14T10:00:00Z", hfBefore: 1.05, hfAfter: 1.3, amount: "5000000", status: "success", policyId: policy.policyId, links: { baseRepayTx: "0xabc" } },
      { id: "b", dryRun: false, triggeredAt: "2026-11-14T11:00:00Z", hfBefore: 1.05, amount: "1000000", status: "success", policyId: policy.policyId, links: { baseRepayTx: "https://basescan.org/tx/0xdef" } },
    ];
    const snap = await getDashboard(policy.policyId);
    expect(snap.policy.state === "ok" && snap.policy.data.chain.name).toBe("Arbitrum One");
    if (snap.history.state !== "ok") throw new Error("history should load");
    const byId = Object.fromEntries(snap.history.data.map((r) => [r.id, r.links.baseRepayTx]));
    expect(byId.a).toBe("https://arbiscan.io/tx/0xabc");
    // A full URL the agent stored is kept as is.
    expect(byId.b).toBe("https://basescan.org/tx/0xdef");
  });

  it("an unactivated policy still shows the loan and says the derived balances are not available", async () => {
    policy = snapshotFor(arbitrumChain, { base_address: null });
    const snap = await getDashboard(policy.policyId);
    if (snap.position.state !== "ok") throw new Error("the loan belongs to the borrower and needs no derived address");
    expect(snap.position.data.usdcBalance).toBeNull();
    expect(snap.position.data.ethBalance).toBeNull();
  });
});
