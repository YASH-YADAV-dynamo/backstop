// Pure helpers (no DOM, no network). Imported by app.js and selftest.mjs.
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const ORIGIN_ASSET = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
export const WNEAR_ASSET = "nep141:wrap.near";
export const MIN_USDC = "0.5";
export const MAX_USDC = "15";
export const NEAR_DECIMALS = 24;
export const USDC_DECIMALS = 6;

const NEAR_ID_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
export function isNearAccountId(s) {
  return typeof s === "string" && s.length >= 2 && s.length <= 64 && NEAR_ID_RE.test(s);
}
export const isEvmAddress = (s) => typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);

/** "1.25" -> 1250000n. Throws on bad format or too many decimals. */
export function parseUnits(str, decimals) {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(str).trim());
  if (!m) throw new Error(`"${str}" is not a plain decimal number`);
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new Error(`"${str}" has more than ${decimals} decimal places`);
  return BigInt(m[1] + frac.padEnd(decimals, "0"));
}
/** 1250000n, 6 -> "1.25" (trailing zeros trimmed). */
export function formatUnits(value, decimals, maxFrac = decimals) {
  const v = BigInt(value);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const frac = (a % base).toString().padStart(decimals, "0").slice(0, maxFrac).replace(/0+$/, "");
  return `${neg ? "-" : ""}${a / base}${frac ? "." + frac : ""}`;
}

const pad32 = (hex) => hex.padStart(64, "0");
/** ERC-20 transfer(address,uint256) calldata. */
export function encodeErc20Transfer(to, amount) {
  if (!isEvmAddress(to)) throw new Error("transfer target is not a 0x + 40 hex address");
  const a = BigInt(amount);
  if (a <= 0n || a >= 2n ** 256n) throw new Error("transfer amount out of range");
  return "0xa9059cbb" + pad32(to.slice(2).toLowerCase()) + pad32(a.toString(16));
}
/** ERC-20 balanceOf(address) calldata. */
export function encodeBalanceOf(owner) {
  if (!isEvmAddress(owner)) throw new Error("owner is not a 0x + 40 hex address");
  return "0x70a08231" + pad32(owner.slice(2).toLowerCase());
}

/** Wallet errors that mean "a request is already open in the wallet". */
export function isPendingWalletError(err) {
  const msg = String(err?.message ?? err ?? "").toLowerCase();
  return err?.code === -32002 || msg.includes("already pending") || msg.includes("previous request is still active") ||
    msg.includes("already processing") || msg.includes("connection declined");
}
export const PENDING_MESSAGE = "Open your wallet, finish or reject the pending request, then press Try again";

/**
 * Pick the NEAR destination asset from the /v0/tokens list.
 * Prefers a token on blockchain "near" with symbol exactly "NEAR" (native) that is not wrap.near;
 * otherwise falls back to nep141:wrap.near (wNEAR). Returns {assetId, decimals, symbol, native}.
 */
export function chooseNearDestination(tokens) {
  const onNear = Array.isArray(tokens) ? tokens.filter((t) => t && t.blockchain === "near") : [];
  const native = onNear.find((t) => t.symbol === "NEAR" && t.assetId !== WNEAR_ASSET);
  if (native) return { assetId: native.assetId, decimals: native.decimals, symbol: "NEAR", native: true };
  const w = onNear.find((t) => t.assetId === WNEAR_ASSET);
  return { assetId: WNEAR_ASSET, decimals: w?.decimals ?? NEAR_DECIMALS, symbol: w?.symbol ?? "wNEAR", native: false };
}

const isUintStr = (s) => typeof s === "string" && /^\d{1,39}$/.test(s);

/**
 * Safety checks for a REAL (dry:false) quote response. Returns an array of problems; empty = OK.
 * expected: {recipient, refundTo, originAsset, destinationAsset, amount (string, 6dp int), usdc}
 */
export function checkQuote(resp, expected, nowMs = Date.now()) {
  const bad = [];
  const req = resp?.quoteRequest, q = resp?.quote;
  if (!req || typeof req !== "object" || !q || typeof q !== "object") return ["response has no quoteRequest/quote"];
  const eq = (name, got, want, ci = false) => {
    const same = ci ? String(got).toLowerCase() === String(want).toLowerCase() : got === want;
    if (!same) bad.push(`${name}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  };
  eq("dry", req.dry, false);
  eq("swapType", req.swapType, "EXACT_INPUT");
  if (req.depositType !== undefined) eq("depositType", req.depositType, "ORIGIN_CHAIN");
  if (req.recipientType !== undefined) eq("recipientType", req.recipientType, "DESTINATION_CHAIN");
  if (req.refundType !== undefined) eq("refundType", req.refundType, "ORIGIN_CHAIN");
  eq("recipient", req.recipient, expected.recipient);
  eq("refundTo", req.refundTo, expected.refundTo, true);
  eq("originAsset", req.originAsset, expected.originAsset);
  eq("destinationAsset", req.destinationAsset, expected.destinationAsset);
  eq("request amount", String(req.amount), expected.amount);
  if (!isUintStr(q.amountIn)) bad.push("amountIn is not an integer string");
  else eq("amountIn", q.amountIn, expected.amount);
  const da = q.depositAddress;
  if (typeof da !== "string" || !da) bad.push("depositAddress missing or empty");
  else if (!isEvmAddress(da)) bad.push(`depositAddress "${da}" is not 0x + 40 hex (Base address)`);
  else if (/^0x0{40}$/i.test(da) || da.toLowerCase() === String(expected.usdc).toLowerCase()) {
    bad.push("depositAddress is the zero address or the USDC contract itself");
  }
  if (q.depositMemo) bad.push("depositMemo present: a Base ERC-20 transfer cannot carry a memo");
  const dl = Date.parse(q.deadline ?? "");
  if (!Number.isFinite(dl)) bad.push("deadline missing or not a date");
  else if (dl <= nowMs) bad.push(`deadline ${q.deadline} is not in the future`);
  if (!isUintStr(q.minAmountOut) || BigInt(q.minAmountOut) <= 0n) bad.push("minAmountOut is missing or not > 0");
  if (!isUintStr(q.amountOut) || BigInt(q.amountOut) <= 0n) bad.push("amountOut is missing or not > 0");
  return bad;
}

/** Decode a NEAR RPC call_function result ({result: number[]}) holding a JSON string, e.g. "123". */
export function decodeCallResult(res) {
  const bytes = Uint8Array.from(res?.result ?? []);
  const v = JSON.parse(new TextDecoder().decode(bytes));
  if (typeof v !== "string" || !/^\d+$/.test(v)) throw new Error("unexpected ft_balance_of result");
  return BigInt(v);
}

/** before/after: {native: bigint, wnear: bigint} in yocto. */
export function verdict(before, after) {
  const dn = after.native - before.native, dw = after.wnear - before.wnear;
  const f = (x) => formatUnits(x, NEAR_DECIMALS, 6);
  if (dw > 0n && dn <= 0n) return { kind: "wnear", text: `wNEAR ARRIVED: +${f(dw)} wNEAR (native unchanged)` };
  if (dn > 0n && dw <= 0n) return { kind: "native", text: `NATIVE NEAR ARRIVED: +${f(dn)} NEAR` };
  if (dn > 0n && dw > 0n) return { kind: "both", text: `Both changed: native +${f(dn)} NEAR, wNEAR +${f(dw)}. Check manually.` };
  return { kind: "none", text: "Nothing arrived yet (balances unchanged). Re-check in a minute." };
}
