import { ONE_CLICK } from "@backstop/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loanChainById } from "@backstop/config";
import { OneClickError, pollStatus, quote, resolveUsdcAssets, submitDeposit, type StatusUpdate } from "../src/index.js";

const NEAR_ID = ONE_CLICK.expectedUsdcNearAssetId;
const BASE_ID = ONE_CLICK.expectedUsdcBaseAssetId;
const RECIPIENT = "0x1b48b83a308ea4beb845db088180dc3389f8aa3b";
const FAST = { backoffMs: 1, retries: 2 };

const tokens = [
  { assetId: "nep141:wrap.near", decimals: 24, blockchain: "near", symbol: "wNEAR", contractAddress: "wrap.near", price: 3.7 },
  { assetId: NEAR_ID, decimals: 6, blockchain: "near", symbol: "USDC", contractAddress: NEAR_ID.slice(7), price: 1 },
  { assetId: BASE_ID, decimals: 6, blockchain: "base", symbol: "USDC", contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" },
];

const quoteBody = (over: Record<string, unknown> = {}, quoteOver: Record<string, unknown> = {}) => ({
  correlationId: "c1",
  timestamp: "2026-11-12T00:00:00Z",
  signature: "ed25519:sig",
  quoteRequest: {
    dry: true,
    swapType: "EXACT_OUTPUT",
    originAsset: NEAR_ID,
    destinationAsset: BASE_ID,
    amount: "2000000",
    recipient: RECIPIENT,
    refundTo: "example.near",
    extraField: "ignored",
    ...over,
  },
  quote: {
    amountIn: "2012702",
    minAmountIn: "2002638",
    amountOut: "2000000",
    minAmountOut: "2000000",
    timeEstimate: 22,
    withdrawFee: "2400",
    ...quoteOver,
  },
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function mockFetch(...responses: Array<Response | Error>) {
  const fn = vi.fn<typeof fetch>();
  for (const r of responses) {
    if (r instanceof Error) fn.mockRejectedValueOnce(r);
    else fn.mockResolvedValueOnce(r);
  }
  vi.stubGlobal("fetch", fn);
  return fn;
}

const statusBody = (status: string, swapDetails: Record<string, unknown> = {}) => ({
  correlationId: "s1",
  status,
  updatedAt: "2026-11-12T00:00:00Z",
  quoteResponse: {},
  swapDetails: { intentHashes: [], nearTxHashes: [], originChainTxHashes: [], destinationChainTxHashes: [], ...swapDetails },
});

afterEach(() => vi.unstubAllGlobals());

describe("resolveUsdcAssets", () => {
  it("finds USDC on NEAR and Base and matches the expected ids", async () => {
    mockFetch(json(tokens));
    const a = await resolveUsdcAssets(loanChainById(8453), FAST);
    expect(a.near.assetId).toBe(NEAR_ID);
    expect(a.dest.assetId).toBe(BASE_ID);
  });

  it("finds native USDC on Arbitrum, not the bridged USDC.e", async () => {
    const arb = loanChainById(42161);
    const withArb = [
      ...tokens,
      { assetId: arb.usdcAssetId, decimals: 6, blockchain: "arb", symbol: "USDC", contractAddress: arb.aave.usdc, price: 1, priceUpdatedAt: "2026-11-13T00:00:00Z" },
      { assetId: "nep141:arb-0xff970a61a04b1ca14834a43f5de4533ebddb5cc8.omft.near", decimals: 6, blockchain: "arb", symbol: "USDC", contractAddress: "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8", price: 1, priceUpdatedAt: "2026-11-13T00:00:00Z" },
    ];
    mockFetch(json(withArb));
    const a = await resolveUsdcAssets(arb, FAST);
    expect(a.dest.assetId).toBe("nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near");
  });

  it("refuses when the asset id differs from the expected one", async () => {
    mockFetch(json(tokens.map((t) => (t.blockchain === "base" ? { ...t, assetId: "nep141:evil.near" } : t))));
    await expect(resolveUsdcAssets(loanChainById(8453), FAST)).rejects.toThrow(/expects nep141:base-0x8335/);
  });

  it("refuses when USDC on Base is missing", async () => {
    mockFetch(json(tokens.filter((t) => t.blockchain !== "base")));
    await expect(resolveUsdcAssets(loanChainById(8453), FAST)).rejects.toThrow(/lists 0 USDC tokens on base/);
  });

  it("rejects a token list that fails validation", async () => {
    mockFetch(json([{ assetId: NEAR_ID, decimals: "six" }]));
    await expect(resolveUsdcAssets(loanChainById(8453), FAST)).rejects.toThrow(/failed validation/);
  });

  it("sends X-API-Key only when a JWT is set", async () => {
    const f = mockFetch(json(tokens), json(tokens));
    await resolveUsdcAssets(loanChainById(8453), FAST);
    await resolveUsdcAssets(loanChainById(8453), { ...FAST, jwt: "jwt-123" });
    const headers = (i: number) => f.mock.calls[i]![1]!.headers as Record<string, string>;
    expect(headers(0)["X-API-Key"]).toBeUndefined();
    expect(headers(1)["X-API-Key"]).toBe("jwt-123");
  });
});

describe("quote", () => {
  const assets = {
    near: { assetId: NEAR_ID, decimals: 6, blockchain: "near", symbol: "USDC" },
    dest: { assetId: BASE_ID, decimals: 6, blockchain: "base", symbol: "USDC" },
  };
  const params = { dry: true, amountOut: 2_000_000n, recipient: RECIPIENT, refundTo: "example.near", assets };

  it("requests EXACT_OUTPUT and parses amounts as bigint", async () => {
    const f = mockFetch(json(quoteBody()));
    const q = await quote(params, FAST);
    expect(q).toMatchObject({ swapType: "EXACT_OUTPUT", amountIn: 2_012_702n, amountOut: 2_000_000n, timeEstimate: 22 });
    const sent = JSON.parse(f.mock.calls[0]![1]!.body as string);
    expect(sent).toMatchObject({ swapType: "EXACT_OUTPUT", slippageTolerance: 50, amount: "2000000", depositType: "ORIGIN_CHAIN" });
    expect(new Date(sent.deadline).getTime()).toBeGreaterThan(Date.now() + 29 * 60_000);
  });

  it("rejects a quote whose recipient differs from ours", async () => {
    mockFetch(json(quoteBody({ recipient: "0x000000000000000000000000000000000000dead" })));
    await expect(quote(params, FAST)).rejects.toThrow(/does not match our request \(recipient/);
  });

  it("rejects an EXACT_OUTPUT quote that guarantees less than requested", async () => {
    mockFetch(json(quoteBody({}, { minAmountOut: "1990000" })));
    await expect(quote(params, FAST)).rejects.toThrow(/guarantees only 1990000/);
  });

  it("rejects a non-dry quote without a deposit address", async () => {
    mockFetch(json(quoteBody({ dry: false })));
    await expect(quote({ ...params, dry: false }, FAST)).rejects.toThrow(/without a depositAddress/);
  });

  it("rejects non-integer amounts in the response", async () => {
    mockFetch(json(quoteBody({}, { amountIn: "2.01" })));
    await expect(quote(params, FAST)).rejects.toThrow(/quote.amountIn: expected an integer amount string/);
  });

  it("retries on 5xx and network errors, then succeeds", async () => {
    const f = mockFetch(json({ error: "busy" }, 503), new TypeError("fetch failed"), json(quoteBody()));
    await expect(quote(params, FAST)).resolves.toMatchObject({ amountOut: 2_000_000n });
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("does not retry 4xx", async () => {
    const f = mockFetch(json({ message: "amount too low" }, 400));
    await expect(quote(params, FAST)).rejects.toBeInstanceOf(OneClickError);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("gives up after the retry budget", async () => {
    mockFetch(json({}, 502), json({}, 502), json({}, 502));
    await expect(quote(params, FAST)).rejects.toThrow(/failed after 3 attempts/);
  });

  it("rejects a non-EVM recipient before calling the API", async () => {
    const f = mockFetch();
    await expect(quote({ ...params, recipient: "alice.near" }, FAST)).rejects.toThrow(/EVM address/);
    expect(f).not.toHaveBeenCalled();
  });
});

describe("submitDeposit", () => {
  it("posts the deposit and returns the validated status", async () => {
    const f = mockFetch(json(statusBody("KNOWN_DEPOSIT_TX")));
    const u = await submitDeposit({ txHash: "Hx", depositAddress: "dep.near", nearSenderAccount: "owner.near" }, FAST);
    expect(u.status).toBe("KNOWN_DEPOSIT_TX");
    expect(JSON.parse(f.mock.calls[0]![1]!.body as string)).toEqual({
      txHash: "Hx",
      depositAddress: "dep.near",
      nearSenderAccount: "owner.near",
    });
  });

  it("rejects an unknown status value", async () => {
    mockFetch(json(statusBody("ALMOST_DONE")));
    await expect(
      submitDeposit({ txHash: "Hx", depositAddress: "dep.near", nearSenderAccount: "owner.near" }, FAST),
    ).rejects.toThrow(/failed validation/);
  });
});

describe("pollStatus", () => {
  it("polls until SUCCESS and returns destination tx hashes with explorer URLs", async () => {
    const dest = { hash: "0xabc", explorerUrl: "https://basescan.org/tx/0xabc" };
    const f = mockFetch(
      json(statusBody("PENDING_DEPOSIT")),
      json(statusBody("PROCESSING")),
      json(statusBody("PROCESSING")),
      json(statusBody("SUCCESS", { amountOut: "2000000", nearTxHashes: ["N1"], destinationChainTxHashes: [dest] })),
    );
    const seen: StatusUpdate["status"][] = [];
    const r = await pollStatus("dep.near", { intervalMs: 1, onUpdate: (u) => seen.push(u.status) }, FAST);
    expect(r.status).toBe("SUCCESS");
    expect(r.destinationTxs).toEqual([dest]);
    expect(r.amountOut).toBe(2_000_000n);
    expect(r.statusUrl).toBe(`${ONE_CLICK.baseUrl}/v0/status?depositAddress=dep.near`);
    expect(seen).toEqual(["PENDING_DEPOSIT", "PROCESSING", "SUCCESS"]);
    expect(f).toHaveBeenCalledTimes(4);
  });

  it.each(["REFUNDED", "FAILED", "INCOMPLETE_DEPOSIT"])("resolves on %s", async (status) => {
    mockFetch(json(statusBody(status, { refundedAmount: "2000000", refundReason: "deadline" })));
    const r = await pollStatus("dep.near", { intervalMs: 1 }, FAST);
    expect(r.status).toBe(status);
    expect(r.refundedAmount).toBe(2_000_000n);
  });

  it("times out with the last status and a link to check", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => json(statusBody("PROCESSING"))));
    await expect(pollStatus("dep.near", { intervalMs: 5, timeoutMs: 20 }, FAST)).rejects.toThrow(
      /still PROCESSING .* check https:\/\/1click\.chaindefuser\.com\/v0\/status\?depositAddress=dep\.near/,
    );
  });
});
