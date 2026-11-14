/**
 * Chain + protocol registry. Browser-safe: no Node imports, no env reads. Import it from client
 * code as `@backstop/config/registry`.
 *
 * Addresses come from official sources only:
 * - Aave v3 Base: @bgd-labs/aave-address-book (AaveV3Base)
 * - Chain Signatures MPC contract: docs.near.org (mainnet `v1.signer`)
 * - RPC lists: docs.near.org/api/rpc/providers and docs.base.org
 * - 1Click asset IDs: resolved at runtime from GET /v0/tokens; the ids below are used to
 *   sanity-check that lookup and are stored in every policy.
 */
import { AaveV3Arbitrum, AaveV3Base } from "@bgd-labs/aave-address-book";

export const NEAR = {
  networkId: "mainnet",
  explorer: "https://nearblocks.io",
  mpcContract: "v1.signer",
  derivationPath: "backstop-base-1",
  /** NEP-141 USDC on NEAR (native Circle USDC). */
  usdcToken: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  /** USDC token storage_balance_bounds (min == max), read live 2026-11-13. */
  usdcStorageDeposit: "1250000000000000000000",
  rpcUrls: ["https://free.rpc.fastnear.com", "https://near.drpc.org", "https://rpc.intea.rs"],
} as const;

export const BASE = {
  chainId: 8453,
  name: "Base",
  explorer: "https://basescan.org",
  rpcUrls: ["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.drpc.org"],
} as const;

export const ARBITRUM = {
  chainId: 42161,
  name: "Arbitrum One",
  explorer: "https://arbiscan.io",
  /** First entry is Arbitrum's own public endpoint (docs.arbitrum.io); the others are public fallbacks. */
  rpcUrls: ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com", "https://arbitrum.drpc.org"],
} as const;

/** The Aave v3 addresses and USDC asset Backstop uses on one chain. */
export interface AaveChainConfig {
  pool: `0x${string}`;
  wethGateway: `0x${string}`;
  /** Native Circle USDC, the token 1Click delivers and Aave's variable debt is paid in. */
  usdc: `0x${string}`;
  usdcVariableDebtToken: `0x${string}`;
  usdcDecimals: number;
  weth: `0x${string}`;
  /** Aave interestRateMode 2 = variable rate (stable rate is deprecated). */
  variableRateMode: number;
}

/**
 * Aave v3 Arbitrum. Aave's `USDC` entry there is the bridged USDC.e (0xFF97...); the native Circle USDC
 * that 1Click delivers is `USDCn`. Backstop only repays the native-USDC market.
 */
export const AAVE_ARBITRUM: AaveChainConfig = {
  pool: AaveV3Arbitrum.POOL as `0x${string}`,
  wethGateway: AaveV3Arbitrum.WETH_GATEWAY as `0x${string}`,
  usdc: AaveV3Arbitrum.ASSETS.USDCn.UNDERLYING as `0x${string}`,
  usdcVariableDebtToken: AaveV3Arbitrum.ASSETS.USDCn.V_TOKEN as `0x${string}`,
  usdcDecimals: AaveV3Arbitrum.ASSETS.USDCn.decimals,
  weth: AaveV3Arbitrum.ASSETS.WETH.UNDERLYING as `0x${string}`,
  variableRateMode: 2,
};

export const AAVE_BASE = {
  pool: AaveV3Base.POOL as `0x${string}`,
  wethGateway: AaveV3Base.WETH_GATEWAY as `0x${string}`,
  usdc: AaveV3Base.ASSETS.USDC.UNDERLYING as `0x${string}`,
  usdcVariableDebtToken: AaveV3Base.ASSETS.USDC.V_TOKEN as `0x${string}`,
  usdcDecimals: AaveV3Base.ASSETS.USDC.decimals,
  weth: AaveV3Base.ASSETS.WETH.UNDERLYING as `0x${string}`,
  /** Aave interestRateMode 2 = variable rate (stable rate is deprecated). */
  variableRateMode: 2,
} as const;

export const ONE_CLICK = {
  baseUrl: "https://1click.chaindefuser.com",
  usdcNearSymbol: "USDC",
  expectedUsdcNearAssetId: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  expectedUsdcBaseAssetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  expectedUsdcArbitrumAssetId: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
  /** 1Click quote-signing key (ed25519). Policies store it as `bridge_signer_pk`. */
  managerPublicKey: "ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc",
} as const;

export const POLICY = {
  version: "2.1.0",
  /** Methods the agent's function-call key may call. */
  agentMethods: ["rescue", "fund_bridge", "approve_pool"],
  /** Gas to attach, in TGas. */
  gas: { rescue: 300, fundBridge: 150, withdraw: 50, activate: 50, owner: 30, close: 100, createPolicy: 300 },
} as const;

/** Factory views (contracts/factory): `list_policies` caps `limit` at this. */
export const FACTORY = { listPageMax: 100 } as const;

/**
 * Service fee: a share of each bridged amount, paid in NEAR USDC to a fixed
 * NEAR account in the same atomic batch that pays 1Click. Rate and account are fixed when the policy is
 * created; the contract hard-caps the rate at `maxBps`.
 */
export const FEE = { maxBps: 50, defaultBps: 10 } as const;

export const NEAR_AI = { baseUrl: "https://cloud-api.near.ai/v1" } as const;

/**
 * A chain Backstop can protect a loan on. A policy stores its chain id, Aave Pool, USDC and the 1Click
 * destination asset at creation; every client resolves the chain from the policy's `chain_id`.
 */
export interface LoanChain {
  chainId: number;
  /** Short key used in flags and file names. */
  key: "base" | "arbitrum";
  name: string;
  explorer: string;
  rpcUrls: readonly string[];
  /** `.env` variable that overrides `rpcUrls`. */
  rpcEnvVar: "BASE_RPC_URL" | "ARBITRUM_RPC_URL";
  aave: AaveChainConfig;
  /** 1Click asset id of native USDC on this chain (the bridge destination stored in the policy). */
  usdcAssetId: string;
  /** 1Click blockchain id used in /v0/tokens. */
  oneClickChain: "base" | "arb";
  /**
   * How the chain charges for posting calldata to Ethereum: `op-stack` adds a separate L1 data fee the
   * sender's balance must also cover (read from the GasPriceOracle); `in-gas-price` (Arbitrum) folds it
   * into the L2 gas estimate, so nothing extra is needed.
   */
  l1Fee: "op-stack" | "in-gas-price";
}

export const LOAN_CHAINS: readonly LoanChain[] = [
  { chainId: BASE.chainId, key: "base", name: BASE.name, explorer: BASE.explorer, rpcUrls: BASE.rpcUrls, rpcEnvVar: "BASE_RPC_URL", aave: AAVE_BASE, usdcAssetId: ONE_CLICK.expectedUsdcBaseAssetId, oneClickChain: "base", l1Fee: "op-stack" },
  { chainId: ARBITRUM.chainId, key: "arbitrum", name: ARBITRUM.name, explorer: ARBITRUM.explorer, rpcUrls: ARBITRUM.rpcUrls, rpcEnvVar: "ARBITRUM_RPC_URL", aave: AAVE_ARBITRUM, usdcAssetId: ONE_CLICK.expectedUsdcArbitrumAssetId, oneClickChain: "arb", l1Fee: "in-gas-price" },
];

export const SUPPORTED_CHAIN_NAMES = LOAN_CHAINS.map((c) => `${c.name} (${c.chainId})`).join(", ");

/** The loan chain for a policy's `chain_id`; throws with the supported list when it is not one we run. */
export function loanChainById(chainId: number): LoanChain {
  const found = LOAN_CHAINS.find((c) => c.chainId === chainId);
  if (!found) throw new Error(`Chain id ${chainId} is not supported. Backstop protects loans on: ${SUPPORTED_CHAIN_NAMES}.`);
  return found;
}

export function loanChainByKey(key: string): LoanChain {
  const found = LOAN_CHAINS.find((c) => c.key === key);
  if (!found) throw new Error(`Unknown chain "${key}". Use one of: ${LOAN_CHAINS.map((c) => c.key).join(", ")}.`);
  return found;
}

export const chainTxUrl = (chain: LoanChain, hash: string) => `${chain.explorer}/tx/${hash}`;
export const chainAddressUrl = (chain: LoanChain, addr: string) => `${chain.explorer}/address/${addr}`;
export const baseTxUrl = (hash: string) => `${BASE.explorer}/tx/${hash}`;
export const baseAddressUrl = (addr: string) => `${BASE.explorer}/address/${addr}`;
export const nearTxUrl = (hash: string) => `${NEAR.explorer}/txns/${hash}`;
export const nearAccountUrl = (accountId: string) => `${NEAR.explorer}/address/${accountId}`;
