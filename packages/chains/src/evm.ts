/** Base (EVM) reads and broadcast via viem. */
import {
  createPublicClient,
  erc20Abi,
  fallback,
  http,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { arbitrum, base, type Chain } from "viem/chains";
import { estimateL1Fee } from "viem/op-stack";
import { chainTxUrl, LOAN_CHAINS, type LoanChain } from "@backstop/config";

/** viem chain definition per registry entry. Adding a chain to LOAN_CHAINS requires an entry here (tested). */
export const VIEM_CHAINS: Record<number, Chain> = { [base.id]: base, [arbitrum.id]: arbitrum };

function viemChain(chain: LoanChain): Chain {
  const c = VIEM_CHAINS[chain.chainId];
  if (!c) throw new Error(`No viem chain definition for ${chain.name} (${chain.chainId}). Add it to VIEM_CHAINS in packages/chains/src/evm.ts.`);
  return c;
}

export const allViemChainsCovered = (): boolean => LOAN_CHAINS.every((c) => VIEM_CHAINS[c.chainId] !== undefined);

export interface Fees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/** Per-request timeout for each RPC endpoint. */
const RPC_TIMEOUT_MS = 10_000;

/** A viem public client for a loan chain over one or more RPC URLs (default: the registry list), tried in order. */
export function evmClient(chain: LoanChain, urls: string | readonly string[] = chain.rpcUrls): PublicClient {
  const list = typeof urls === "string" ? [urls] : [...urls];
  if (list.length === 0) throw new Error(`No ${chain.name} RPC URL configured. Set ${chain.rpcEnvVar} or use the built-in list.`);
  const transport = fallback(list.map((u) => http(u, { timeout: RPC_TIMEOUT_MS })), { rank: false });
  // Cast: some chains add formatters (OP-stack deposit txs) that the generic PublicClient type
  // (what chainsig.js and our helpers accept) does not model; reads are unaffected.
  return createPublicClient({ chain: viemChain(chain), transport }) as PublicClient;
}

/** Fails loudly when the RPC is not the expected chain, so nothing is signed for the wrong chain. */
export async function assertChainId(client: PublicClient, chain: LoanChain): Promise<void> {
  const chainId = await client.getChainId();
  if (chainId !== chain.chainId) {
    throw new Error(`The ${chain.name} RPC reports chainId ${chainId}, expected ${chain.chainId} (${chain.name}). Fix ${chain.rpcEnvVar} in .env.`);
  }
}

/** `eth_sendRawTransaction`; returns the tx hash. */
export async function broadcastRaw(client: PublicClient, signedTx: Hex): Promise<Hash> {
  try {
    return await client.sendRawTransaction({ serializedTransaction: signedTx });
  } catch (err) {
    const reason = err instanceof Error ? err.message.split("\n")[0] : String(err);
    throw new Error(
      `The chain rejected the signed tx: ${reason}. Common causes: nonce already used (re-run to re-sign with a fresh nonce), ` +
        `fee too low (re-run to re-estimate), or not enough ETH for gas (fund the address).`,
    );
  }
}

/** Waits for the tx to be mined; throws with the explorer link if it reverted or timed out. */
export async function waitForReceipt(client: PublicClient, chain: LoanChain, hash: Hash, timeoutMs = 120_000): Promise<TransactionReceipt> {
  let receipt: TransactionReceipt;
  try {
    receipt = await client.waitForTransactionReceipt({ hash, timeout: timeoutMs });
  } catch {
    throw new Error(`No receipt for ${chainTxUrl(chain, hash)} after ${timeoutMs / 1000}s. Check the link; if it is unknown, re-run.`);
  }
  if (receipt.status !== "success") {
    throw new Error(`Tx reverted: ${chainTxUrl(chain, hash)}. Open the link for the revert reason before retrying.`);
  }
  return receipt;
}

/** ERC-20 `balanceOf(owner)` in the token's smallest unit. */
export function erc20Balance(client: PublicClient, token: Address, owner: Address): Promise<bigint> {
  return client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
}

/** Next nonce including pending txs. */
export function nonceOf(client: PublicClient, address: Address): Promise<number> {
  return client.getTransactionCount({ address, blockTag: "pending" });
}

/** Current EIP-1559 fee estimate from the RPC. */
export async function feeEstimate(client: PublicClient): Promise<Fees> {
  const { maxFeePerGas, maxPriorityFeePerGas } = await client.estimateFeesPerGas();
  return { maxFeePerGas, maxPriorityFeePerGas };
}

/**
 * Extra wei the sender must hold on top of gas for posting calldata to Ethereum. Base is an OP-stack L2:
 * every tx pays a separate L1 data fee, read from the GasPriceOracle predeploy. Arbitrum folds the L1
 * component into its gas estimate, so there is nothing extra (`l1Fee: "in-gas-price"` in the registry).
 */
export async function l1DataFee(
  client: PublicClient,
  chain: LoanChain,
  tx: { from: Address; to: Address; value: bigint; data: Hex },
): Promise<bigint> {
  if (chain.l1Fee === "in-gas-price") return 0n;
  return estimateL1Fee(client, { account: tx.from, to: tx.to, value: tx.value, data: tx.data, chain: viemChain(chain) as typeof base });
}
