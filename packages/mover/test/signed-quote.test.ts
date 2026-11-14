import { readFileSync } from "node:fs";
import { generateKeyPairSync, sign } from "node:crypto";
import { NEAR, ONE_CLICK } from "@backstop/config";
import { verifyQuoteSignature, type OneClickQuoteResponse } from "@defuse-protocol/one-click-sdk-typescript";
import bs58 from "bs58";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertQuoteForPolicy,
  bridgeQuote,
  canonicalQuote,
  parseIsoUtcSecs,
  quoteMessage,
  verifyCanonicalQuote,
  type QuoteExpectations,
} from "../src/index.js";

/** The recorded live 1Click quote shared with contracts/policy `live_1click_quote_fixture_verifies`. */
const fixture = JSON.parse(
  readFileSync(new URL("../../../contracts/policy/tests/fixtures/quote.json", import.meta.url), "utf8"),
) as { response: OneClickQuoteResponse & Record<string, unknown>; canonical: string; signature: string };

const live = fixture.response;
const liveNow = parseIsoUtcSecs(live.timestamp)! + 60;
const liveExpect: QuoteExpectations = {
  policyId: live.quoteRequest.refundTo,
  derived: live.quoteRequest.recipient,
  usdcNear: NEAR.usdcToken,
  destAsset: ONE_CLICK.expectedUsdcBaseAssetId,
  nowSecs: liveNow,
  maxAmountIn: 5_000_000n,
};

afterEach(() => vi.unstubAllGlobals());

describe("recorded live 1Click quote", () => {
  it("verifies with the 1Click SDK", () => {
    expect(verifyQuoteSignature(live, ONE_CLICK.managerPublicKey)).toBe(true);
  });

  it("rebuilds exactly the string the SDK hashes, and it verifies with node:crypto", () => {
    expect(canonicalQuote(live)).toBe(fixture.canonical);
    expect(verifyCanonicalQuote(fixture.canonical, live.signature)).toBe(true);
    expect(verifyCanonicalQuote(canonicalQuote(live), live.signature, ONE_CLICK.managerPublicKey)).toBe(true);
  });

  it("does not verify once one byte changes, or with another key", () => {
    const tampered = fixture.canonical.replace('"amountIn":"5000000"', '"amountIn":"5000001"');
    expect(tampered).not.toBe(fixture.canonical);
    expect(verifyCanonicalQuote(tampered, live.signature)).toBe(false);
    const sdkTampered = { ...live, quote: { ...live.quote, depositAddress: "a".repeat(64) } };
    expect(verifyQuoteSignature(sdkTampered as OneClickQuoteResponse)).toBe(false);
    expect(verifyCanonicalQuote(fixture.canonical, live.signature, "ed25519:" + bs58.encode(new Uint8Array(32).fill(1)))).toBe(false);
    expect(verifyCanonicalQuote(fixture.canonical, "ed25519:abc")).toBe(false);
    expect(verifyCanonicalQuote(fixture.canonical, live.signature.slice("ed25519:".length))).toBe(false);
  });

  it("passes every policy check for its own refundTo / recipient inside its time window", () => {
    expect(assertQuoteForPolicy(fixture.canonical, liveExpect)).toEqual({
      amountIn: 5_000_000n,
      minAmountOut: 4_972_025n,
      depositAddress: live.quote.depositAddress,
      deadlineSecs: parseIsoUtcSecs(live.quote.deadline!),
      timestampSecs: parseIsoUtcSecs(live.timestamp),
    });
  });
});

describe("parseIsoUtcSecs (same vectors as the contract)", () => {
  it("matches date -u -d", () => {
    expect(parseIsoUtcSecs("2026-11-13T06:03:47.271Z")).toBe(1_794_549_827);
    expect(parseIsoUtcSecs("1970-01-01T00:00:00Z")).toBe(0);
    expect(parseIsoUtcSecs("2024-02-29T12:00:00Z")).toBe(1_709_208_000);
  });
  it("rejects malformed input", () => {
    for (const s of ["2026-11-13T06:03:47", "2026-11-13T06:03:47+00:00", "2026-02-29T00:00:00Z", "2026-11-13T24:00:00Z", "2026-11-13T06:03:47.Z", "2026-11-13T06:03:47.1234567890Z"]) {
      expect(parseIsoUtcSecs(s), s).toBeUndefined();
    }
  });
});

describe("assertQuoteForPolicy rejections", () => {
  const edit = (patch: (q: Record<string, unknown>) => void): string => {
    const q = JSON.parse(fixture.canonical) as Record<string, unknown>;
    patch(q);
    return JSON.stringify(q);
  };
  const rejects = (canonical: string, code: string, expected: Partial<QuoteExpectations> = {}) =>
    expect(() => assertQuoteForPolicy(canonical, { ...liveExpect, ...expected })).toThrow(new RegExp(`^${code}:`));

  it.each([
    ["ERR_QUOTE_DRY", (q: Record<string, unknown>) => (q.dry = true)],
    ["ERR_QUOTE_SWAP_TYPE", (q: Record<string, unknown>) => (q.swapType = "EXACT_OUTPUT")],
    ["ERR_QUOTE_DEPOSIT_TYPE", (q: Record<string, unknown>) => (q.depositType = "INTENTS")],
    ["ERR_QUOTE_ORIGIN_ASSET", (q: Record<string, unknown>) => (q.originAsset = "nep141:wrap.near")],
    ["ERR_QUOTE_DESTINATION_ASSET", (q: Record<string, unknown>) => (q.destinationAsset = "nep141:eth.omft.near")],
    ["ERR_QUOTE_RECIPIENT_TYPE", (q: Record<string, unknown>) => (q.recipientType = "INTENTS")],
    ["ERR_QUOTE_RECIPIENT", (q: Record<string, unknown>) => (q.recipient = "0x1111222233334444555566667777888899990000")],
    ["ERR_QUOTE_REFUND_TYPE", (q: Record<string, unknown>) => (q.refundType = "INTENTS")],
    ["ERR_QUOTE_REFUND_TO", (q: Record<string, unknown>) => (q.refundTo = "attacker.near")],
    ["ERR_QUOTE_DEPOSIT_ADDRESS", (q: Record<string, unknown>) => (q.depositAddress = "attacker.near")],
    ["ERR_QUOTE_DEPOSIT_ADDRESS", (q: Record<string, unknown>) => (q.depositAddress = "AB".repeat(32))],
    ["ERR_QUOTE_AMOUNT_FORMAT", (q: Record<string, unknown>) => (q.amountOut = "-1")],
    ["ERR_QUOTE_AMOUNT_FORMAT", (q: Record<string, unknown>) => (q.amount = (2n ** 128n).toString())],
    ["ERR_QUOTE_AMOUNT_MISMATCH", (q: Record<string, unknown>) => (q.minAmountIn = "1")],
    ["ERR_QUOTE_LOSS_TOO_HIGH", (q: Record<string, unknown>) => (q.minAmountOut = "4899999")],
    ["ERR_QUOTE_TIME_FORMAT", (q: Record<string, unknown>) => (q.timestamp = "yesterday")],
    ["ERR_QUOTE_TIME_FORMAT", (q: Record<string, unknown>) => (q.deadline = "2026-11-16")],
    ["ERR_QUOTE_SHAPE", (q: Record<string, unknown>) => (q.customRecipientMsg = "x")],
    ["ERR_QUOTE_SHAPE", (q: Record<string, unknown>) => (q.virtualChainRecipient = "x.near")],
    ["ERR_QUOTE_SHAPE", (q: Record<string, unknown>) => (q.virtualChainRefundRecipient = "x.near")],
    ["ERR_QUOTE_SHAPE", (q: Record<string, unknown>) => (q.depositMemo = "1")],
    ["ERR_QUOTE_SHAPE", (q: Record<string, unknown>) => (q.newField = 1)],
    ["ERR_QUOTE_SHAPE", (q: Record<string, unknown>) => delete q.recipient],
  ])("%s", (code, patch) => rejects(edit(patch), code));

  it("rejects a dust amount", () => {
    rejects(
      edit((q) => {
        for (const k of ["amount", "amountIn", "minAmountIn", "minAmountOut"]) q[k] = "99999";
      }),
      "ERR_BRIDGE_AMOUNT_TOO_SMALL",
    );
  });

  it("rejects stale, future and soon-expiring quotes", () => {
    const ts = parseIsoUtcSecs(live.timestamp)!;
    expect(() => assertQuoteForPolicy(fixture.canonical, { ...liveExpect, nowSecs: ts + 600 })).not.toThrow();
    rejects(fixture.canonical, "ERR_QUOTE_STALE", { nowSecs: ts + 601 });
    expect(() => assertQuoteForPolicy(fixture.canonical, { ...liveExpect, nowSecs: ts - 120 })).not.toThrow();
    rejects(fixture.canonical, "ERR_QUOTE_STALE", { nowSecs: ts - 121 });
    const iso = (secs: number) => new Date(secs * 1000).toISOString();
    expect(() => assertQuoteForPolicy(edit((q) => (q.deadline = iso(liveNow + 600))), liveExpect)).not.toThrow();
    rejects(edit((q) => (q.deadline = iso(liveNow + 599))), "ERR_QUOTE_DEADLINE_TOO_SOON");
  });

  it("compares the recipient case-insensitively and rejects more than the caller allows", () => {
    const upper = edit((q) => (q.recipient = String(q.recipient).toUpperCase().replace("0X", "0x")));
    expect(() => assertQuoteForPolicy(upper, liveExpect)).not.toThrow();
    rejects(fixture.canonical, "ERR_OVER_MAX_PER_RESCUE", { maxAmountIn: 4_999_999n });
  });

  it("rejects an overlong or non-JSON quote", () => {
    rejects("x".repeat(4097), "ERR_QUOTE_TOO_LONG");
    rejects("not json", "ERR_QUOTE_SHAPE");
  });
});

describe("bridgeQuote", () => {
  const params = {
    destAsset: ONE_CLICK.expectedUsdcBaseAssetId,
    amountIn: 5_000_000n,
    recipient: live.quoteRequest.recipient,
    refundTo: live.quoteRequest.refundTo,
    nowMs: liveNow * 1000,
  };
  const serve = (body: unknown) => {
    const fn = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal("fetch", fn);
    return fn;
  };

  it("sends a non-dry EXACT_INPUT quote request and returns the signed string", async () => {
    const fetchMock = serve(live);
    const q = await bridgeQuote(params, { retries: 0 });
    expect(q.canonical).toBe(fixture.canonical);
    expect(q.signature).toBe(fixture.signature);
    expect(q.depositAddress).toBe(live.quote.depositAddress);
    expect(q.minAmountOut).toBe(4_972_025n);
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      dry: false,
      swapType: "EXACT_INPUT",
      amount: "5000000",
      originAsset: ONE_CLICK.expectedUsdcNearAssetId,
      destinationAsset: ONE_CLICK.expectedUsdcBaseAssetId,
      recipient: params.recipient,
      refundTo: params.refundTo,
      refundType: "ORIGIN_CHAIN",
      recipientType: "DESTINATION_CHAIN",
      depositType: "ORIGIN_CHAIN",
    });
  });

  it("refuses a response whose signature does not cover it", async () => {
    serve({ ...live, quote: { ...live.quote, depositAddress: "a".repeat(64) } });
    await expect(bridgeQuote(params, { retries: 0 })).rejects.toThrow(/ERR_QUOTE_SIGNATURE_INVALID/);
  });

  it("refuses a validly signed quote for another policy", async () => {
    serve(live);
    await expect(bridgeQuote({ ...params, refundTo: "other.near" }, { retries: 0 })).rejects.toThrow(/ERR_QUOTE_REFUND_TO/);
  });

  it("refuses a correctly signed quote that fails a policy check (signed by a test key)", async () => {
    // Re-sign a modified quote with a throwaway key: the SDK check (real 1Click key) must refuse it.
    const { privateKey } = generateKeyPairSync("ed25519");
    const changed = { ...live, quote: { ...live.quote, minAmountOut: "1" } };
    const sig = sign(null, quoteMessage(canonicalQuote(changed)), privateKey);
    serve({ ...changed, signature: "ed25519:" + bs58.encode(sig) });
    await expect(bridgeQuote(params, { retries: 0 })).rejects.toThrow(/ERR_QUOTE_SIGNATURE_INVALID/);
  });

  it("rejects amounts below the policy minimum and slippage above its loss cap before calling 1Click", async () => {
    const fetchMock = serve(live);
    await expect(bridgeQuote({ ...params, amountIn: 99_999n })).rejects.toThrow(/below the policy minimum/);
    await expect(bridgeQuote({ ...params, slippageBps: 201 })).rejects.toThrow(/slippageBps/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
