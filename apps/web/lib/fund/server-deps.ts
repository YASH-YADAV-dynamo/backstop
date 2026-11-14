/** Real network dependencies for the fund routes. Server only (imports @backstop/mover, which uses node:crypto). */
import { oneClickOptionsFromEnv, resolveUsdcAssets } from "@backstop/mover";
import { loadWebEnv, rpcList } from "@backstop/config";
import { LOAN_CHAINS, NEAR, ONE_CLICK } from "@backstop/config/registry";
import { tokenListSchema, type OriginToken } from "@/lib/fund/shared";
import type { FundDeps } from "@/lib/fund/handler";
import { configureNearRpc } from "@/lib/near-rpc";
import { readExpectedCodeHash, readPolicy, readUsdcStorage, verifyPolicy } from "@/lib/policy-client";

const oneClickOptions = () => oneClickOptionsFromEnv({ ONE_CLICK_JWT: process.env.ONE_CLICK_JWT || undefined });

let tokenCache: { at: number; tokens: OriginToken[] } | null = null;
let assetCache: string | null = null;

async function postJson(path: string, body: unknown): Promise<unknown> {
  const opts = oneClickOptions();
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (opts.jwt) headers["X-API-Key"] = opts.jwt;
  const res = await fetch(`${ONE_CLICK.baseUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000), cache: "no-store" });
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 200);
    try {
      const j = JSON.parse(text) as { message?: unknown };
      if (typeof j.message === "string") message = j.message;
    } catch {
      /* keep raw text */
    }
    throw new Error(`1Click answered HTTP ${res.status}: ${message}`);
  }
  return JSON.parse(text) as unknown;
}

export function realDeps(): FundDeps {
  const env = loadWebEnv();
  configureNearRpc(rpcList(env.NEAR_RPC_URL, NEAR.rpcUrls));
  return {
    tokens: async () => {
      if (tokenCache && Date.now() - tokenCache.at < 5 * 60_000) return tokenCache.tokens;
      const res = await fetch(`${ONE_CLICK.baseUrl}/v0/tokens`, { signal: AbortSignal.timeout(20_000), cache: "no-store" });
      if (!res.ok) throw new Error(`1Click /v0/tokens answered HTTP ${res.status}`);
      const tokens = tokenListSchema.parse(await res.json());
      tokenCache = { at: Date.now(), tokens };
      return tokens;
    },
    // The NEAR-side USDC asset does not depend on the loan chain, so any registry entry works; only `.near` is used.
    nearUsdcAssetId: async () => (assetCache ??= (await resolveUsdcAssets(LOAN_CHAINS[0]!, oneClickOptions())).near.assetId),
    verifyPolicy: async (policyId) => verifyPolicy(await readPolicy(policyId), await readExpectedCodeHash().catch(() => null)),
    usdcRegistered: async (policyId) => (await readUsdcStorage(policyId)) !== null,
    requestQuote: (body) => postJson("/v0/quote", body),
    now: () => Date.now(),
    extraFee: !oneClickOptions().jwt,
  };
}

export const statusOptions = oneClickOptions;
