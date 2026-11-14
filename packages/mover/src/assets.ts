import { ONE_CLICK, type LoanChain } from "@backstop/config";
import { requestJson, type OneClickOptions } from "./http.js";
import { tokenListSchema, type Token } from "./schemas.js";

export interface UsdcAssets {
  /** USDC on NEAR (origin), e.g. nep141:17208628f8...6133a1 */
  near: Token;
  /** USDC on the loan chain (destination), e.g. nep141:base-0x833589...02913.omft.near */
  dest: Token;
}

/** NEAR native USDC contract id: the `nep141:` asset id without the prefix. */
const NEAR_USDC_CONTRACT = ONE_CLICK.expectedUsdcNearAssetId.replace(/^nep141:/, "");

function pick(tokens: Token[], blockchain: string, contractAddress: string, expectedId: string, expectedDecimals: number): Token {
  const matches = tokens.filter(
    (t) =>
      t.blockchain === blockchain &&
      t.symbol === ONE_CLICK.usdcNearSymbol &&
      t.contractAddress?.toLowerCase() === contractAddress.toLowerCase(),
  );
  if (matches.length !== 1) {
    throw new Error(
      `1Click /v0/tokens lists ${matches.length} USDC tokens on ${blockchain} with contract ${contractAddress} (expected 1). ` +
        "Do not move funds: check https://1click.chaindefuser.com/v0/tokens and update ONE_CLICK in @backstop/config.",
    );
  }
  const token = matches[0]!;
  if (token.assetId !== expectedId) {
    throw new Error(
      `1Click USDC on ${blockchain} has asset id ${token.assetId}, but @backstop/config expects ${expectedId}. ` +
        "Do not move funds until the difference is understood; update ONE_CLICK in @backstop/config if 1Click changed it.",
    );
  }
  if (token.decimals !== expectedDecimals) {
    throw new Error(`1Click USDC on ${blockchain} reports ${token.decimals} decimals, expected ${expectedDecimals}.`);
  }
  return token;
}

/** GET /v0/tokens and find USDC on NEAR and on the loan chain, cross-checked against the ids in @backstop/config. */
export async function resolveUsdcAssets(chain: LoanChain, opts: OneClickOptions = {}): Promise<UsdcAssets> {
  const tokens = await requestJson("/v0/tokens", tokenListSchema, { method: "GET" }, opts);
  return {
    near: pick(tokens, "near", NEAR_USDC_CONTRACT, ONE_CLICK.expectedUsdcNearAssetId, chain.aave.usdcDecimals),
    dest: pick(tokens, chain.oneClickChain, chain.aave.usdc, chain.usdcAssetId, chain.aave.usdcDecimals),
  };
}
