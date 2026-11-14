import assert from "node:assert/strict";
import * as h from "./helpers.mjs";

// calldata: transfer(0x1111..1111, 1_000_000 = 0xf4240)
assert.equal(
  h.encodeErc20Transfer("0x1111111111111111111111111111111111111111", 1000000n),
  "0xa9059cbb" + "0".repeat(24) + "1".repeat(40) + "0".repeat(59) + "f4240",
);
assert.equal(h.encodeBalanceOf("0x1111111111111111111111111111111111111111"), "0x70a08231" + "0".repeat(24) + "1".repeat(40));
assert.throws(() => h.encodeErc20Transfer("0x12", 1n));
assert.throws(() => h.encodeErc20Transfer("0x1111111111111111111111111111111111111111", 0n));

// account ids
for (const ok of ["alice.near", "a-b_c.sub.near", "ab", "f".repeat(64)]) assert.ok(h.isNearAccountId(ok), ok);
for (const no of ["", "a", "Alice.near", "alice..near", ".near", "-a.near", "a b.near", "x".repeat(65), "alice.near\n"]) {
  assert.ok(!h.isNearAccountId(no), JSON.stringify(no));
}

// amounts
assert.equal(h.parseUnits("1.00", 6), 1000000n);
assert.equal(h.parseUnits("0.5", 6), 500000n);
assert.throws(() => h.parseUnits("1.0000001", 6));
assert.throws(() => h.parseUnits("-1", 6));
assert.throws(() => h.parseUnits("1e3", 6));
assert.equal(h.formatUnits(1250000n, 6), "1.25");
assert.equal(h.formatUnits(10n ** 24n, 24), "1");
assert.equal(h.formatUnits(5n, 24, 6), "0");

// destination choice
const wn = { blockchain: "near", assetId: "nep141:wrap.near", symbol: "wNEAR", decimals: 24 };
assert.equal(h.chooseNearDestination([wn]).native, false);
const nat = h.chooseNearDestination([wn, { blockchain: "near", assetId: "native:near", symbol: "NEAR", decimals: 24 }]);
assert.equal(nat.native, true);
assert.equal(h.chooseNearDestination([]).assetId, "nep141:wrap.near");

// wallet errors
assert.ok(h.isPendingWalletError({ code: -32002 }));
assert.ok(h.isPendingWalletError(new Error("Request of type 'wallet_requestPermissions' already pending")));
assert.ok(!h.isPendingWalletError({ code: 4001, message: "User rejected" }));

// quote check
const exp = { recipient: "alice.near", refundTo: "0xAbCdEf0123456789abcdef0123456789ABCDEF01", originAsset: h.ORIGIN_ASSET, destinationAsset: h.WNEAR_ASSET, amount: "1000000", usdc: h.BASE_USDC };
const now = Date.parse("2026-11-14T10:00:00Z");
const good = () => ({
  quoteRequest: { dry: false, swapType: "EXACT_INPUT", depositType: "ORIGIN_CHAIN", recipientType: "DESTINATION_CHAIN", refundType: "ORIGIN_CHAIN", recipient: "alice.near", refundTo: exp.refundTo, originAsset: exp.originAsset, destinationAsset: exp.destinationAsset, amount: "1000000" },
  quote: { amountIn: "1000000", amountOut: "300000000000000000000000", minAmountOut: "297000000000000000000000", depositAddress: "0x2222222222222222222222222222222222222222", deadline: "2026-11-14T10:30:00Z" },
});
assert.deepEqual(h.checkQuote(good(), exp, now), []);
const t = (fn) => { const g = good(); fn(g); return h.checkQuote(g, exp, now); };
assert.ok(t((g) => (g.quoteRequest.recipient = "mallory.near")).length);
assert.ok(t((g) => (g.quoteRequest.refundTo = "0x3333333333333333333333333333333333333333")).length);
assert.ok(t((g) => (g.quote.amountIn = "2000000")).length);
assert.ok(t((g) => (g.quote.depositAddress = "")).length);
assert.ok(t((g) => (g.quote.depositAddress = "bc1qxyz")).length);
assert.ok(t((g) => (g.quote.depositAddress = h.BASE_USDC)).length);
assert.ok(t((g) => (g.quote.deadline = "2026-11-14T09:00:00Z")).length);
assert.ok(t((g) => (g.quote.minAmountOut = "0")).length);
assert.ok(t((g) => (g.quoteRequest.destinationAsset = "nep141:evil.near")).length);
assert.ok(t((g) => (g.quoteRequest.dry = true)).length);
assert.ok(h.checkQuote({}, exp, now).length);

// call result + verdict
assert.equal(h.decodeCallResult({ result: [...new TextEncoder().encode('"12345"')] }), 12345n);
const Y = 10n ** 24n;
assert.equal(h.verdict({ native: Y, wnear: 0n }, { native: 2n * Y, wnear: 0n }).kind, "native");
assert.equal(h.verdict({ native: Y, wnear: 0n }, { native: Y, wnear: Y }).text, "wNEAR ARRIVED: +1 wNEAR (native unchanged)");
assert.equal(h.verdict({ native: Y, wnear: 0n }, { native: Y, wnear: 0n }).kind, "none");
console.log("selftest OK");
