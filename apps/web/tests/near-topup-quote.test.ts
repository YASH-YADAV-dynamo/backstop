import { canonicalQuote, quoteMessage, verifyCanonicalQuote } from "@backstop/mover";
import { NEAR_TOPUP_DESTINATION } from "@backstop/config/near-topup";
import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleTopUpQuote, type TopUpDeps } from "@/lib/fund/near-topup";
import { buildTopUpQuoteBody, checkTopUpQuote, limitsFor, topUpRequestSchema, type TopUpQuoteView } from "@/lib/fund/near-topup-shared";
import type { OriginToken } from "@/lib/fund/shared";
import { base58Encode } from "@/lib/validate";

/** A throwaway ed25519 key stands in for 1Click's quote-signing key: no network, no real quote. */
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const TEST_PK = `ed25519:${base58Encode(new Uint8Array(publicKey.export({ format: "der", type: "spki" }).subarray(-32)))}`;
const signCanonical = (canonical: string) => `ed25519:${base58Encode(new Uint8Array(sign(null, quoteMessage(canonical), privateKey)))}`;

const NOW = Date.parse("2026-11-14T12:00:00.000Z");
const NEAR = 10n ** 24n;
const NEED = 4n * NEAR + NEAR / 5n; // 4.2 NEAR: deposit + gas allowance
const ACCOUNT = "alice.near";
const REFUND = "0x1111111111111111111111111111111111111111";
const DEPOSIT = "0x2222222222222222222222222222222222222222";
const BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const BASE_ETH = "nep141:base.omft.near";
const GOOD = { originChain: "base", originAsset: BASE_USDC, amount: "5000000", recipient: ACCOUNT, refundTo: REFUND };

const tokens: OriginToken[] = [
  { assetId: BASE_USDC, decimals: 6, blockchain: "base", symbol: "USDC", contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" },
  { assetId: BASE_ETH, decimals: 18, blockchain: "base", symbol: "ETH" },
  { assetId: "nep141:wrap.near", decimals: 24, blockchain: "near", symbol: "wNEAR", contractAddress: "wrap.near" },
];

type Raw = { timestamp: string; signature: string; quoteRequest: Record<string, unknown>; quote: Record<string, unknown> };

/** What 1Click would answer to `body`, signed with the test key. `tamper` edits it BEFORE signing (a quote 1Click really signed, but wrong). */
function fakeQuote(body: Record<string, unknown>, tamper?: (r: Raw) => void): Raw {
  const dry = body.dry === true;
  const raw: Raw = {
    timestamp: new Date(NOW).toISOString(),
    signature: "",
    quoteRequest: { ...body },
    quote: {
      amountIn: body.amount,
      amountInFormatted: "5.0",
      amountInUsd: "4.9982",
      minAmountIn: body.amount,
      amountOut: (15n * NEAR / 10n).toString(),
      amountOutFormatted: "1.5",
      amountOutUsd: "4.95",
      minAmountOut: (1485n * NEAR / 1000n).toString(),
      ...(dry ? {} : { depositAddress: DEPOSIT, deadline: new Date(NOW + 30 * 60_000).toISOString(), timeWhenInactive: new Date(NOW + 30 * 60_000).toISOString() }),
      timeEstimate: 25,
    },
  };
  tamper?.(raw);
  raw.signature = signCanonical(canonicalQuote(raw));
  return raw;
}

function deps(over: Partial<TopUpDeps> & { tamper?: (r: Raw) => void; afterSign?: (r: Raw) => void; seen?: (b: Record<string, unknown>) => void } = {}): TopUpDeps {
  const { tamper, afterSign, seen, ...rest } = over;
  return {
    enabled: true,
    tokens: async () => tokens,
    needYocto: () => NEED,
    accountExists: async () => true,
    requestQuote: async (body) => {
      seen?.(body);
      const raw = fakeQuote(body, tamper);
      afterSign?.(raw);
      return raw;
    },
    verifySignature: (canonical, signature) => verifyCanonicalQuote(canonical, signature, TEST_PK),
    now: () => NOW,
    extraFee: true,
    ...rest,
  };
}

describe("POST /api/near-topup/quote handler", () => {
  it("accepts a good signed quote and returns the signed amounts", async () => {
    const res = await handleTopUpQuote(GOOD, deps());
    expect(res.status).toBe(200);
    const body = res.body as TopUpQuoteView;
    expect(body.depositAddress).toBe(DEPOSIT);
    expect(body.recipient).toBe(ACCOUNT);
    expect(body.destinationAsset).toBe(NEAR_TOPUP_DESTINATION.assetId);
    expect(body.delivery).toBe("native");
    expect(body.amountIn).toBe("5000000");
    expect(body.minAmountOut).toBe((1485n * NEAR / 1000n).toString());
    expect(body.amountInUsd).toBeCloseTo(4.9982);
    expect(body.timeEstimate).toBe(25);
  });

  it("a dry price check returns amounts and no deposit address", async () => {
    const res = await handleTopUpQuote({ ...GOOD, dry: true }, deps());
    expect(res.status).toBe(200);
    expect((res.body as TopUpQuoteView).depositAddress).toBeUndefined();
    expect((res.body as TopUpQuoteView).dry).toBe(true);
  });

  it("sends 1Click a fixed destination, recipient type, swap type and refund type", async () => {
    let sent: Record<string, unknown> = {};
    await handleTopUpQuote(GOOD, deps({ seen: (b) => (sent = b) }));
    expect(sent).toMatchObject({
      dry: false,
      swapType: "EXACT_INPUT",
      depositType: "ORIGIN_CHAIN",
      destinationAsset: "nep141:wrap.near",
      recipient: ACCOUNT,
      recipientType: "DESTINATION_CHAIN",
      refundType: "ORIGIN_CHAIN",
      refundTo: REFUND,
      originAsset: BASE_USDC,
      amount: "5000000",
    });
  });

  it("the client cannot pick the destination, recipient type, swap type or refund type", async () => {
    for (const extra of [
      { destinationAsset: "nep141:evil.near" },
      { recipientType: "INTENTS" },
      { swapType: "EXACT_OUTPUT" },
      { refundType: "INTENTS" },
      { depositType: "INTENTS" },
      { slippageTolerance: 5000 },
    ]) {
      const res = await handleTopUpQuote({ ...GOOD, ...extra }, deps());
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    // And the builder ignores anything but the validated fields.
    const body = buildTopUpQuoteBody({ ...GOOD, destinationAsset: "nep141:evil.near", recipientType: "INTENTS" } as never, NOW);
    expect(body.destinationAsset).toBe("nep141:wrap.near");
    expect(body.recipientType).toBe("DESTINATION_CHAIN");
  });

  it("validates the body: account id, refund address, amount, chain, asset", async () => {
    const bad = [
      { ...GOOD, recipient: "Not A Near Id!" },
      { ...GOOD, refundTo: "not-an-address" },
      { ...GOOD, amount: "0" },
      { ...GOOD, amount: "1.5" },
      { ...GOOD, originChain: "eth" },
      { ...GOOD, originAsset: "nep141:wrap.near" },
      {},
    ];
    for (const b of bad) expect((await handleTopUpQuote(b, deps())).status, JSON.stringify(b)).toBe(400);
    expect(topUpRequestSchema.safeParse(GOOD).success).toBe(true);
    expect(topUpRequestSchema.safeParse({ ...GOOD, originAsset: BASE_ETH, amount: "2000000000000000" }).success).toBe(true);
  });

  it("is off (404) when the flag is off, and never asks 1Click", async () => {
    let asked = false;
    const res = await handleTopUpQuote(GOOD, deps({ enabled: false, seen: () => (asked = true) }));
    expect(res.status).toBe(404);
    expect(asked).toBe(false);
  });

  it("refuses when vault creation is not configured, or the asset is not listed as expected", async () => {
    expect((await handleTopUpQuote(GOOD, deps({ needYocto: () => null }))).status).toBe(409);
    expect((await handleTopUpQuote(GOOD, deps({ tokens: async () => tokens.filter((t) => t.assetId !== BASE_USDC) }))).status).toBe(503);
  });

  it("native delivery: a brand-new NEAR account that does not exist yet still gets a quote (the delivery creates it)", async () => {
    const res = await handleTopUpQuote(GOOD, deps({ accountExists: async () => false }));
    expect(res.status).toBe(200);
  });

  it("refuses a quote altered after signing (signature no longer verifies)", async () => {
    const res = await handleTopUpQuote(GOOD, deps({ afterSign: (r) => (r.quote.depositAddress = "0x3333333333333333333333333333333333333333") }));
    expect(res.status).toBe(502);
    expect((res.body as { error: string }).error).toMatch(/signature/);
  });

  const tampered: Array<[string, (r: Raw) => void]> = [
    ["recipient", (r) => (r.quoteRequest.recipient = "evil.near")],
    ["refundTo", (r) => (r.quoteRequest.refundTo = "0x9999999999999999999999999999999999999999")],
    ["destination asset", (r) => (r.quoteRequest.destinationAsset = "nep141:usdt.tether-token.near")],
    ["origin asset", (r) => (r.quoteRequest.originAsset = BASE_ETH)],
    ["amount", (r) => (r.quoteRequest.amount = "50000000")],
    ["amountIn", (r) => (r.quote.amountIn = "50000000")],
    ["deadline too soon", (r) => (r.quote.deadline = new Date(NOW + 60_000).toISOString())],
    ["deadline in the past", (r) => (r.quote.deadline = new Date(NOW - 60_000).toISOString())],
    ["deadline more than 7 days away", (r) => (r.quote.deadline = new Date(NOW + 8 * 24 * 3_600_000).toISOString())],
    ["deposit address format", (r) => (r.quote.depositAddress = "abcdef0123456789")],
    ["recipient type", (r) => (r.quoteRequest.recipientType = "INTENTS")],
    ["dry flag", (r) => (r.quoteRequest.dry = true)],
    ["over the USD limit", (r) => (r.quote.amountInUsd = "50.01")],
    ["no USD value", (r) => delete r.quote.amountInUsd],
    ["more NEAR than the need + 10%", (r) => (r.quote.amountOut = r.quote.minAmountOut = (5n * NEAR).toString())],
    ["minimum above expected", (r) => (r.quote.minAmountOut = (2n * NEAR).toString())],
    ["a memo", (r) => (r.quote.depositMemo = "123")],
  ];
  for (const [what, tamper] of tampered) {
    it(`refuses a signed quote with a wrong ${what}`, async () => {
      const res = await handleTopUpQuote(GOOD, deps({ tamper }));
      expect(res.status).toBe(502);
      expect("depositAddress" in res.body).toBe(false);
      // The signature was valid: the signed-field / limit check is what refused it.
      expect((res.body as { error: string }).error).toMatch(/signed quote was refused/);
    });
  }

  it("accepts the 72 h deposit window 1Click actually signs (it ignores the 30 min we ask for)", async () => {
    const res = await handleTopUpQuote(GOOD, deps({ tamper: (r) => (r.quote.deadline = new Date(NOW + 72 * 3_600_000).toISOString()) }));
    expect(res.status).toBe(200);
  });

  it("checkTopUpQuote refuses a deposit address on screen that differs from the signed one", () => {
    const raw = fakeQuote(buildTopUpQuoteBody(GOOD, NOW));
    const canonical = canonicalQuote(raw);
    const expected = { dry: false, ...GOOD };
    expect(checkTopUpQuote(canonical, expected, { depositAddress: DEPOSIT, depositMemo: undefined }, limitsFor(NEED), NOW).ok).toBe(true);
    const r = checkTopUpQuote(canonical, expected, { depositAddress: "0x3333333333333333333333333333333333333333", depositMemo: undefined }, limitsFor(NEED), NOW);
    expect(r.ok).toBe(false);
  });
});

describe("POST /api/near-topup/quote route", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const post = (body: unknown) =>
    new Request("http://localhost/api/near-topup/quote", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" }, body: JSON.stringify(body) });

  it("flag off (the default): 404 for every request", async () => {
    vi.resetModules();
    const { POST } = await import("@/app/api/near-topup/quote/route");
    const res = await POST(post(GOOD));
    expect(res.status).toBe(404);
  });

  it("flag on: invalid bodies get 400, then the 11th request in a minute gets 429", async () => {
    vi.stubEnv("NEXT_PUBLIC_GET_NEAR_ENABLED", "1");
    vi.resetModules();
    const { POST } = await import("@/app/api/near-topup/quote/route");
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await POST(post({ ...GOOD, recipient: "BAD ID" }))).status);
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(400));
    expect(statuses[10]).toBe(429);
  });
});
