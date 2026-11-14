/** Shared setup for the operator scripts: env, RPC clients, the policy's derived loan-chain address. */
import type { Address, PublicClient } from "viem";
import type { Provider } from "near-api-js";
import { NEAR, LOAN_CHAINS, loadEnv, loanChainByKey, requireEnv, rpcList, type Env, type LoanChain } from "@backstop/config";
import { assertChainId, evmClient, nearProvider } from "@backstop/chains";
import { deriveEvmAddress } from "@backstop/signer";

export interface ScriptContext {
  env: Env;
  policyContractId: string;
  chain: LoanChain;
  client: PublicClient;
  provider: Provider;
  /** Loan-chain address derived from (POLICY_CONTRACT_ID, NEAR.derivationPath); the same on every EVM chain. */
  derived: Address;
}

/** NEAR_RPC_URL overrides first, then the registry defaults. */
export const nearUrlsFor = (env: Env): string[] => rpcList(env.NEAR_RPC_URL, NEAR.rpcUrls);
export const nearProviderFor = (env: Env): Provider => nearProvider(nearUrlsFor(env));

/** `--chain` option shared by the scripts; the default keeps every pre-D29 command working on Base. */
export const CHAIN_OPTION = { chain: { type: "string", default: "base" } } as const;
export const CHAIN_FLAG_HELP = `--chain ${LOAN_CHAINS.map((c) => c.key).join("|")} (default base)`;

/** Resolves `--chain` with the registry; the error lists the supported keys. */
export const chainFromFlag = (value: string | undefined): LoanChain => loanChainByKey(value ?? "base");

export async function chainClientFor(env: Env, chain: LoanChain): Promise<PublicClient> {
  const client = evmClient(chain, rpcList(env[chain.rpcEnvVar], chain.rpcUrls));
  await assertChainId(client, chain);
  return client;
}

export async function scriptContext(purpose: string, chain: LoanChain): Promise<ScriptContext> {
  const env = loadEnv();
  const { POLICY_CONTRACT_ID } = requireEnv(env, ["POLICY_CONTRACT_ID"], purpose);
  const client = await chainClientFor(env, chain);
  const { address } = await deriveEvmAddress(chain, POLICY_CONTRACT_ID, NEAR.derivationPath);
  return { env, policyContractId: POLICY_CONTRACT_ID, chain, client, provider: nearProviderFor(env), derived: address };
}

/** Prints the error message only (never env values or stack internals) and exits 1. */
export function runMain(main: () => Promise<void>): void {
  main().catch((err: unknown) => {
    console.error(`\nERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
