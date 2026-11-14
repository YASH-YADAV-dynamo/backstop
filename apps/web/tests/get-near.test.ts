import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  amountInForTarget,
  deriveTopUp,
  estimateUsd,
  getNearEnabled,
  notSent,
  parseSavedTopUp,
  progressIndex,
  quoteBlockReason,
  savedTopUpKey,
  shouldReset,
  statusKind,
  DELIVERED_DONE_MS,
  STUCK_MS,
  topUpTarget,
  withTxHash,
  type SavedTopUp,
} from "@/lib/get-near";
import { unwrapTx } from "@/lib/get-near-review";
import { PUBLIC_ENV } from "@/lib/public-env";
import { ethereumWalletNearHint } from "@/lib/wallet-flow";

const NEAR = 10n ** 24n;
const NOW = Date.parse("2026-11-14T12:00:00.000Z");
const ACCOUNT = "alice.near";
const WALLET = "0x1111111111111111111111111111111111111111";

function saved(over: Partial<SavedTopUp> = {}): SavedTopUp {
  return {
    v: 1,
    account: ACCOUNT,
    evmAddress: WALLET,
    symbol: "USDC",
    decimals: 6,
    contract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    quote: {
      dry: false,
      recipient: ACCOUNT,
      originChain: "base",
      originAsset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
      refundTo: WALLET,
      destinationAsset: "nep141:wrap.near",
      delivery: "native",
      depositAddress: "0x2222222222222222222222222222222222222222",
      amountIn: "15000000",
      amountInUsd: 15,
      amountOut: (45n * NEAR / 10n).toString(),
      minAmountOut: (44n * NEAR / 10n).toString(),
      amountOutUsd: 14.8,
      deadline: new Date(NOW + 20 * 60_000).toISOString(),
      timeEstimate: 25,
      signature: "ed25519:x",
      canonical: "{}",
      extraFee: true,
    },
    startNative: (NEAR / 10n).toString(),
    createdAt: NOW - 60_000,
    ...over,
  };
}

const NEED = 4n * NEAR + NEAR / 5n;

describe("flag OFF (default): the app behaves as before", () => {
  it("the flag is off unless NEXT_PUBLIC_GET_NEAR_ENABLED is exactly 1", () => {
    expect(PUBLIC_ENV.getNearEnabled).toBe(false);
    expect(getNearEnabled()).toBe(false);
    expect(getNearEnabled({ getNearEnabled: true })).toBe(true);
  });

  it("the Ethereum-wallet hint keeps today's text when off, and points to the MetaMask / Rabby tab when on", () => {
    const eth = "0x" + "ab".repeat(20);
    const input = { walletName: "Ethereum Wallets", accountId: eth, needYocto: 3n * NEAR, haveYocto: NEAR };
    const off = ethereumWalletNearHint(input);
    expect(off).toBe(ethereumWalletNearHint(input, false));
    expect(off).toBe(
      `Your NEAR account comes from an Ethereum wallet. This step needs about 3 NEAR in NEAR itself; ETH or USDC in that wallet cannot pay it. Send at least 2 NEAR to ${eth} (for example from an exchange), then try again.`,
    );
    const on = ethereumWalletNearHint(input, true);
    expect(on).toContain('"MetaMask / Rabby" tab');
    expect(on).toContain("at least 2 NEAR");
    expect(ethereumWalletNearHint({ ...input, haveYocto: 3n * NEAR }, true)).toBeNull();
  });

  it("the create card mounts the Get NEAR card only behind the flag", () => {
    const src = readFileSync(fileURLToPath(new URL("../components/app/create-vault.tsx", import.meta.url)), "utf8");
    const uses = src.split("\n").filter((l) => l.includes("<GetNear"));
    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatch(/getNearEnabled\(\) &&/);
  });
});

describe("shortfall math", () => {
  it("shortfall + 5% buffer, rounded up; nothing when the account has enough; undecided until read", () => {
    expect(topUpTarget(NEED, null)).toBeNull();
    expect(topUpTarget(NEED, NEED)).toEqual({ shortYocto: 0n, targetYocto: 0n });
    expect(topUpTarget(NEED, NEED + 1n)).toEqual({ shortYocto: 0n, targetYocto: 0n });
    const t = topUpTarget(NEED, NEAR / 5n)!; // has 0.2, needs 4.2
    expect(t.shortYocto).toBe(4n * NEAR);
    expect(t.targetYocto).toBe(42n * NEAR / 10n);
    expect(topUpTarget(100n, 99n)).toEqual({ shortYocto: 1n, targetYocto: 2n }); // rounds up
  });

  it("scales the price check to the target, never below the minimum", () => {
    // 5 USDC bought 1.5 NEAR -> 4.2 NEAR needs 14 USDC.
    const probe = { amountIn: 5_000_000n, amountOut: 15n * NEAR / 10n, amountInUsd: 5 };
    expect(amountInForTarget(42n * NEAR / 10n, probe)).toBe(14_000_000n);
    expect(estimateUsd(14_000_000n, probe)).toBeCloseTo(14);
    // A tiny need is rounded up to the 1 USD minimum (+2%).
    expect(amountInForTarget(NEAR / 1000n, probe)).toBe(1_020_000n);
    expect(() => amountInForTarget(NEAR, { ...probe, amountOut: 0n })).toThrow();
  });
});

describe("status mapping", () => {
  it("maps every 1Click status", () => {
    expect(statusKind(null)).toBe("waiting");
    expect(statusKind("PENDING_DEPOSIT")).toBe("waiting");
    expect(statusKind("KNOWN_DEPOSIT_TX")).toBe("swapping");
    expect(statusKind("PROCESSING")).toBe("swapping");
    expect(statusKind("SUCCESS")).toBe("delivered");
    expect(statusKind("REFUNDED")).toBe("refunded");
    expect(statusKind("FAILED")).toBe("failed");
    expect(statusKind("INCOMPLETE_DEPOSIT")).toBe("incomplete");
  });
});

describe("which step the card shows", () => {
  const base = { needYocto: NEED, nowMs: NOW, wrappedYocto: null, status: null } as const;

  it("hidden when the account has enough and nothing is in flight; arrived when it has enough after a swap", () => {
    expect(deriveTopUp({ ...base, saved: null, nativeYocto: NEED }).kind).toBe("hidden");
    expect(deriveTopUp({ ...base, saved: saved(), nativeYocto: NEED, status: "SUCCESS" }).kind).toBe("arrived");
  });

  it("quote -> send -> expired", () => {
    expect(deriveTopUp({ ...base, saved: null, nativeYocto: 0n }).kind).toBe("quote");
    expect(deriveTopUp({ ...base, saved: saved(), nativeYocto: 0n }).kind).toBe("send");
    expect(deriveTopUp({ ...base, saved: saved(), nativeYocto: 0n, nowMs: NOW + 21 * 60_000 }).kind).toBe("expired");
  });

  it("swapping once sent (tx hash or a seen deposit), stuck after 30 minutes", () => {
    expect(deriveTopUp({ ...base, saved: saved({ txHash: "0xabc", sentAt: NOW }), nativeYocto: 0n })).toEqual({ kind: "swapping", stuck: false, delivered: false });
    expect(deriveTopUp({ ...base, saved: saved(), nativeYocto: 0n, status: "PROCESSING" }).kind).toBe("swapping");
    const late = deriveTopUp({ ...base, saved: saved({ txHash: "0xabc", sentAt: NOW }), nativeYocto: 0n, status: "PROCESSING", nowMs: NOW + STUCK_MS + 1 });
    expect(late).toEqual({ kind: "swapping", stuck: true, delivered: false });
  });

  it("SUCCESS alone never counts as arrived: it waits for the native balance", () => {
    const v = deriveTopUp({ ...base, saved: saved({ txHash: "0xabc", sentAt: NOW }), nativeYocto: NEAR / 10n, status: "SUCCESS", wrappedYocto: 0n });
    expect(v).toEqual({ kind: "swapping", stuck: false, delivered: true });
    expect(progressIndex(v)).toBe(2);
  });

  it("a swap delivered long ago is over: short of NEAR again, the card offers a new quote instead of waiting forever", () => {
    const old = saved({ txHash: "0xabc", sentAt: NOW });
    const later = NOW + DELIVERED_DONE_MS + 1;
    expect(deriveTopUp({ ...base, saved: old, nativeYocto: NEAR / 10n, status: "SUCCESS", wrappedYocto: 0n, nowMs: later }).kind).toBe("quote");
    expect(deriveTopUp({ ...base, saved: old, nativeYocto: NEAR / 10n, status: "SUCCESS", wrappedYocto: 0n, nowMs: NOW + DELIVERED_DONE_MS - 1 }).kind).toBe("swapping");
    // Not while the swap itself is still running, and never before a wrapped balance was read.
    expect(deriveTopUp({ ...base, saved: old, nativeYocto: 0n, status: "PROCESSING", nowMs: later }).kind).toBe("swapping");
    expect(deriveTopUp({ ...base, saved: old, nativeYocto: NEAR / 10n, status: "SUCCESS", wrappedYocto: null, delivery: "wrapped", nowMs: later }).kind).toBe("swapping");
  });

  it("wNEAR arrived: unwrap the delivered amount (not more), and say when gas is missing", () => {
    const s = saved({ txHash: "0xabc", sentAt: NOW });
    const v = deriveTopUp({ ...base, saved: s, nativeYocto: NEAR / 10n, status: "SUCCESS", wrappedYocto: 10n * NEAR, statusAmountOut: (45n * NEAR / 10n).toString(), delivery: "wrapped" });
    expect(v).toEqual({ kind: "unwrap", amount: 45n * NEAR / 10n, canPayGas: true });
    const broke = deriveTopUp({ ...base, saved: s, nativeYocto: 0n, status: "SUCCESS", wrappedYocto: NEAR, delivery: "wrapped" });
    expect(broke).toEqual({ kind: "unwrap", amount: NEAR, canPayGas: false });
    // Native delivery never shows the unwrap step.
    expect(deriveTopUp({ ...base, saved: s, nativeYocto: 0n, status: "SUCCESS", wrappedYocto: NEAR, delivery: "native" }).kind).toBe("swapping");
  });

  it("refunded, failed and incomplete deposits", () => {
    const s = saved({ txHash: "0xabc" });
    expect(deriveTopUp({ ...base, saved: s, nativeYocto: 0n, status: "REFUNDED" }).kind).toBe("refunded");
    expect(deriveTopUp({ ...base, saved: s, nativeYocto: 0n, status: "FAILED" }).kind).toBe("failed");
    expect(deriveTopUp({ ...base, saved: s, nativeYocto: 0n, status: "INCOMPLETE_DEPOSIT" }).kind).toBe("incomplete");
  });

  it("NEAR rose but not enough: short", () => {
    const v = deriveTopUp({ ...base, saved: saved({ txHash: "0xabc" }), nativeYocto: 3n * NEAR, status: "SUCCESS", wrappedYocto: 0n });
    expect(v.kind).toBe("short");
  });

  it("wrapped delivery needs a little NEAR first; native does not", () => {
    expect(quoteBlockReason({ nativeYocto: 0n, accountId: ACCOUNT, delivery: "wrapped" })).toMatch(/send at least 0.01 NEAR/);
    expect(quoteBlockReason({ nativeYocto: NEAR / 100n, accountId: ACCOUNT, delivery: "wrapped" })).toBeNull();
    expect(quoteBlockReason({ nativeYocto: 0n, accountId: ACCOUNT, delivery: "native" })).toBeNull();
    expect(quoteBlockReason({ nativeYocto: null, accountId: ACCOUNT })).not.toBeNull();
  });
});

describe("resume after a reload", () => {
  const key = savedTopUpKey(ACCOUNT);

  it("reads back a saved swap for the same account; ignores junk, other accounts, dry quotes and old records", () => {
    const s = saved({ txHash: "0xabc", sentAt: NOW });
    expect(key).toBe("backstop.getnear.alice.near");
    expect(parseSavedTopUp(JSON.stringify(s), ACCOUNT, NOW)).toEqual(s);
    expect(parseSavedTopUp(null, ACCOUNT, NOW)).toBeNull();
    expect(parseSavedTopUp("{not json", ACCOUNT, NOW)).toBeNull();
    expect(parseSavedTopUp(JSON.stringify({ ...s, v: 2 }), ACCOUNT, NOW)).toBeNull();
    expect(parseSavedTopUp(JSON.stringify(s), "bob.near", NOW)).toBeNull();
    expect(parseSavedTopUp(JSON.stringify({ ...s, quote: { ...s.quote, recipient: "bob.near" } }), ACCOUNT, NOW)).toBeNull();
    expect(parseSavedTopUp(JSON.stringify({ ...s, quote: { ...s.quote, dry: true } }), ACCOUNT, NOW)).toBeNull();
    expect(parseSavedTopUp(JSON.stringify(s), ACCOUNT, NOW + 8 * 24 * 3_600_000)).toBeNull();
  });

  it("records the tx hash once", () => {
    const s = withTxHash(saved(), "0xaaa", NOW);
    expect(s.txHash).toBe("0xaaa");
    expect(s.sentAt).toBe(NOW);
    expect(withTxHash(s, "0xbbb", NOW + 1)).toBe(s);
  });

  it("resets on a wallet account change only while nothing was sent", () => {
    const s = saved();
    expect(notSent(s, null)).toBe(true);
    expect(shouldReset(s, WALLET, null)).toBe(false);
    expect(shouldReset(s, WALLET.toUpperCase().replace("0X", "0x"), null)).toBe(false);
    expect(shouldReset(s, null, null)).toBe(false); // disconnected: keep, the user may reconnect
    expect(shouldReset(s, "0x9999999999999999999999999999999999999999", null)).toBe(true);
    expect(shouldReset(s, "0x9999999999999999999999999999999999999999", "PENDING_DEPOSIT")).toBe(true);
    expect(shouldReset(s, "0x9999999999999999999999999999999999999999", "PROCESSING")).toBe(false);
    expect(shouldReset(withTxHash(s, "0xabc", NOW), "0x9999999999999999999999999999999999999999", null)).toBe(false);
  });
});

describe("unwrap transaction", () => {
  it("wrap.near near_withdraw with exactly 1 yoctoNEAR", () => {
    expect(unwrapTx(5n * NEAR)).toEqual({ receiverId: "wrap.near", calls: [{ methodName: "near_withdraw", args: { amount: (5n * NEAR).toString() }, gasTgas: 10, depositYocto: "1" }] });
  });
});
