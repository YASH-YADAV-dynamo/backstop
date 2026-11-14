import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createLimiter } from "@/lib/rate-limit";
import { handleQuote, type FundDeps } from "@/lib/fund/handler";
import { checkSignedFields, type OriginToken } from "@/lib/fund/shared";
import type { Check } from "@/lib/policy-client";

/** A real non-dry 1Click quote captured 2026-11-13 for recipient alice.near (no deposit was made). */
const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/quote-near.json", import.meta.url)), "utf8")) as {
  timestamp: string;
  signature: string;
  quote: Record<string, unknown>;
  quoteRequest: Record<string, unknown>;
};

const POLICY = "alice.near";
const BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const NEAR_USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const REFUND = "0x1111111111111111111111111111111111111111";
const GOOD = { policy: POLICY, originAsset: BASE_USDC, amount: "1000000", refundTo: REFUND };
const tokens: OriginToken[] = [{ assetId: BASE_USDC, decimals: 6, blockchain: "base", symbol: "USDC", contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" }];
const passing: Check[] = [{ id: "keys", label: "No access keys", state: "pass", detail: "" }];

function deps(over: Partial<FundDeps> & { quoteBody?: (b: Record<string, unknown>) => void; raw?: unknown } = {}): FundDeps {
  return {
    tokens: async () => tokens,
    nearUsdcAssetId: async () => NEAR_USDC,
    verifyPolicy: async () => passing,
    usdcRegistered: async () => true,
    requestQuote: async (body) => {
      over.quoteBody?.(body);
      return over.raw ?? fixture;
    },
    now: () => Date.parse(fixture.timestamp),
    extraFee: true,
    ...over,
  };
}

describe("POST /api/fund/quote handler", () => {
  it("accepts a recorded live 1Click quote for a NEAR recipient and returns the signed fields", async () => {
    const res = await handleQuote(GOOD, deps());
    expect(res.status).toBe(200);
    const body = res.body as { depositAddress: string; minAmountOut: string; amountIn: string; deadline: string };
    expect(body.depositAddress).toBe(fixture.quote.depositAddress);
    expect(body.amountIn).toBe("1000000");
    expect(body.minAmountOut).toBe("989800");
    expect(body.deadline).toBe("2026-11-16T13:45:12.000Z");
  });

  it("the client cannot choose the recipient, destination asset, swap type or refund type: extra fields are rejected", async () => {
    for (const extra of [{ recipient: "evil.near" }, { destinationAsset: "nep141:evil" }, { swapType: "EXACT_OUTPUT" }, { refundType: "DESTINATION_CHAIN" }]) {
      const res = await handleQuote({ ...GOOD, ...extra }, deps());
      expect(res.status).toBe(400);
    }
  });

  it("sends 1Click a fixed recipient = policy, destination = NEAR USDC, EXACT_INPUT, refund to origin chain", async () => {
    let sent: Record<string, unknown> = {};
    await handleQuote(GOOD, deps({ quoteBody: (b) => (sent = b) }));
    expect(sent).toMatchObject({
      dry: false,
      swapType: "EXACT_INPUT",
      depositType: "ORIGIN_CHAIN",
      destinationAsset: NEAR_USDC,
      recipient: POLICY,
      recipientType: "DESTINATION_CHAIN",
      refundType: "ORIGIN_CHAIN",
      refundTo: REFUND,
      originAsset: BASE_USDC,
      amount: "1000000",
    });
  });

  it("a tampered quote (bad signature) gives 502 and no deposit address", async () => {
    const tampered = structuredClone(fixture);
    tampered.quote.depositAddress = "0x2222222222222222222222222222222222222222";
    tampered.quote.amountOut = "1";
    const res = await handleQuote(GOOD, deps({ raw: tampered }));
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain("0x2222");
    expect(res.body).not.toHaveProperty("depositAddress");
  });

  it("a validly signed quote for another recipient or refund address gives 502 and no deposit address", async () => {
    const otherRecipient = await handleQuote({ ...GOOD, policy: "bob.near" }, deps());
    expect(otherRecipient.status).toBe(502);
    expect(otherRecipient.body).not.toHaveProperty("depositAddress");
    const otherRefund = await handleQuote({ ...GOOD, refundTo: "0x3333333333333333333333333333333333333333" }, deps());
    expect(otherRefund.status).toBe(502);
    expect(otherRefund.body).not.toHaveProperty("depositAddress");
    const otherAsset = await handleQuote(GOOD, deps({ nearUsdcAssetId: async () => "nep141:other" }));
    expect(otherAsset.status).toBe(502);
  });

  it("a policy that is not registered on NEAR USDC is refused before any quote is requested", async () => {
    let asked = false;
    const res = await handleQuote(GOOD, deps({ usdcRegistered: async () => false, quoteBody: () => (asked = true) }));
    expect(res.status).toBe(409);
    expect(asked).toBe(false);
  });

  it("a policy that fails verification is refused before any quote is requested", async () => {
    let asked = false;
    const failing: Check[] = [{ id: "keys", label: "No access keys", state: "fail", detail: "has a key" }];
    const res = await handleQuote(GOOD, deps({ verifyPolicy: async () => failing, quoteBody: () => (asked = true) }));
    expect(res.status).toBe(409);
    expect(asked).toBe(false);
  });

  it("a policy that cannot be read gives 404", async () => {
    const res = await handleQuote(GOOD, deps({ verifyPolicy: async () => { throw new Error("does not exist"); } }));
    expect(res.status).toBe(404);
  });

  it.each([
    ["not an object", "hello"],
    ["bad policy id", { ...GOOD, policy: "Bad_ID!" }],
    ["zero amount", { ...GOOD, amount: "0" }],
    ["decimal amount", { ...GOOD, amount: "1.5" }],
    ["negative amount", { ...GOOD, amount: "-5" }],
    ["empty refund address", { ...GOOD, refundTo: "" }],
    ["refund address with spaces", { ...GOOD, refundTo: "0x 1" }],
    ["refund address too long", { ...GOOD, refundTo: "a".repeat(129) }],
    ["unknown origin asset", { ...GOOD, originAsset: "nep141:not-a-token" }],
  ])("bad input (%s) gives 400", async (_name, body) => {
    const res = await handleQuote(body, deps());
    expect(res.status).toBe(400);
  });
});

describe("signed quote field check", () => {
  it("passes the recorded quote and flags every changed field", () => {
    const canonical = JSON.stringify({ ...fixture.quoteRequest, ...fixture.quote });
    const expected = { recipient: POLICY, destinationAsset: NEAR_USDC, refundTo: REFUND, originAsset: BASE_USDC, amount: "1000000" };
    expect(checkSignedFields(canonical, expected, fixture.quote.depositAddress as string, undefined)).toEqual([]);
    expect(checkSignedFields(canonical, { ...expected, recipient: "x.near" }, fixture.quote.depositAddress as string, undefined)).toHaveLength(1);
    expect(checkSignedFields(canonical, expected, "0xdead", undefined)).toHaveLength(1);
    expect(checkSignedFields("not json", expected, "a", undefined)).toHaveLength(1);
  });
});

describe("rate limiter", () => {
  it("allows 10 per minute per key and recovers after the window", () => {
    const l = createLimiter(10);
    for (let i = 0; i < 10; i++) expect(l.allow("ip", 1_000 + i)).toBe(true);
    expect(l.allow("ip", 2_000)).toBe(false);
    expect(l.allow("other", 2_000)).toBe(true);
    expect(l.allow("ip", 61_500)).toBe(true);
  });
});

describe("browser re-check of a server quote", () => {
  it("verifies the recorded signature with WebCrypto and rejects a changed deposit address or recipient", async () => {
    const { canonicalQuote } = await import("@backstop/mover");
    const { verifyQuoteInBrowser } = await import("@/lib/fund/client");
    const view = {
      policy: POLICY, originAsset: BASE_USDC, refundTo: REFUND, depositAddress: fixture.quote.depositAddress as string,
      amountIn: "1000000", minAmountOut: "989800", amountOutFormatted: "0.9998", deadline: "2026-11-16T13:45:12.000Z",
      timeEstimate: 35, signature: fixture.signature, canonical: canonicalQuote(fixture), extraFee: true,
    };
    expect(await verifyQuoteInBrowser(view)).toEqual({ ok: true, signature: "verified" });
    expect((await verifyQuoteInBrowser({ ...view, depositAddress: "0x2222222222222222222222222222222222222222" })).ok).toBe(false);
    expect((await verifyQuoteInBrowser({ ...view, policy: "bob.near" })).ok).toBe(false);
    expect((await verifyQuoteInBrowser({ ...view, signature: "ed25519:" + "1".repeat(64) })).ok).toBe(false);
  });
});
