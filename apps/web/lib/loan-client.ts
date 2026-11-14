/** Browser/server reads of a loan chain (ETH balance, USDC balance, Aave position) through viem with RPC failover. */
import type { LoanChain } from "@backstop/config/registry";
import { createPublicClient, fallback, http, parseAbi, type Address, type PublicClient } from "viem";
import { arbitrum, base } from "viem/chains";
import { classifyDebt, type DebtKind } from "@/lib/debt";

const VIEM_CHAINS: Record<number, typeof base | typeof arbitrum> = { [base.id]: base, [arbitrum.id]: arbitrum };

const clients = new Map<string, PublicClient>();

/** One viem client per (chain, rpc list). `urls` overrides the registry list. */
export function chainClient(chain: LoanChain, urls: readonly string[] = chain.rpcUrls): PublicClient {
  const viemChain = VIEM_CHAINS[chain.chainId];
  if (!viemChain) throw new Error(`No viem chain is configured for ${chain.name} (${chain.chainId}). Add it to VIEM_CHAINS in apps/web/lib/loan-client.ts and lib/wagmi.ts.`);
  const key = `${chain.chainId}|${urls.join(",")}`;
  let client = clients.get(key);
  if (!client) {
    // Cast: OP-stack chains (Base) add deposit-tx formatters the generic PublicClient type does not model; reads are unaffected.
    client = createPublicClient({ chain: viemChain, transport: fallback(urls.map((u) => http(u, { timeout: 10_000 }))) }) as PublicClient;
    clients.set(key, client);
  }
  return client;
}

/** The message shown when an RPC answers for a different chain than the policy's (the same words on server and browser). */
export function chainMismatchMessage(chain: LoanChain, answered: number, hosts: readonly string[]): string {
  return `${hosts.join(", ")} answered chain id ${answered}, expected ${chain.name} (${chain.chainId}). Reload the page; if it persists, the ${chain.name} RPC list is wrong (operators: fix ${chain.rpcEnvVar}).`;
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return "The RPC";
  }
};

const verified = new WeakMap<PublicClient, Promise<void>>();

/** Reads `eth_chainId` once per client and refuses an RPC that serves another chain. A failed check is retried on the next call. */
function ensureChain(client: PublicClient, chain: LoanChain): Promise<void> {
  let check = verified.get(client);
  if (!check) {
    check = client.getChainId().then((answered) => {
      if (answered !== chain.chainId) throw new Error(chainMismatchMessage(chain, answered, chain.rpcUrls.map(hostOf)));
    });
    verified.set(client, check);
    check.catch(() => verified.delete(client));
  }
  return check;
}

const poolAbi = parseAbi([
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
]);
const erc20Abi = parseAbi(["function balanceOf(address owner) view returns (uint256)"]);

export type LoanSnapshot = {
  /** wei */
  eth: bigint;
  /** native USDC base units (6dp) at the derived address */
  usdc: bigint;
  /** USD, 8 decimals (Aave base currency) */
  collateralBase: bigint;
  debtBase: bigint;
  /** 1e18-scaled; null when there is no debt (Aave returns uint256 max) */
  healthFactor: bigint | null;
  fetchedAt: number;
};

const UINT_MAX = 2n ** 256n - 1n;

/** Aave position of `borrower` plus ETH and native-USDC balances of `derived`, all on `chain`. */
export async function readLoan(chain: LoanChain, derived: Address | null, borrower: Address, client: PublicClient = chainClient(chain)): Promise<LoanSnapshot> {
  await ensureChain(client, chain);
  const [account, eth, usdc] = await Promise.all([
    client.readContract({ address: chain.aave.pool, abi: poolAbi, functionName: "getUserAccountData", args: [borrower] }),
    derived ? client.getBalance({ address: derived }) : Promise.resolve(0n),
    derived ? client.readContract({ address: chain.aave.usdc, abi: erc20Abi, functionName: "balanceOf", args: [derived] }) : Promise.resolve(0n),
  ]);
  const [collateralBase, debtBase, , , , hf] = account;
  return { eth, usdc, collateralBase, debtBase, healthFactor: debtBase === 0n || hf === UINT_MAX ? null : hf, fetchedAt: Date.now() };
}

export async function readEthBalance(chain: LoanChain, address: Address): Promise<bigint> {
  const client = chainClient(chain);
  await ensureChain(client, chain);
  return client.getBalance({ address });
}

/** Receipt status for a transaction hash on the loan chain, or null while it is not mined yet. */
export async function readLoanReceipt(chain: LoanChain, hash: `0x${string}`): Promise<"success" | "reverted" | null> {
  try {
    const client = chainClient(chain);
    await ensureChain(client, chain);
    return (await client.getTransactionReceipt({ hash })).status;
  } catch {
    return null;
  }
}

export type DebtRead = { kind: DebtKind; healthFactor: bigint | null; debtBase: bigint; collateralBase: bigint };

/** What kind of Aave debt `borrower` has on `chain`: native-USDC variable debt (protectable), other debt, or none. Read-only. */
export async function readDebt(chain: LoanChain, borrower: Address, client: PublicClient = chainClient(chain)): Promise<DebtRead> {
  await ensureChain(client, chain);
  const [account, usdcVariableDebt] = await Promise.all([
    client.readContract({ address: chain.aave.pool, abi: poolAbi, functionName: "getUserAccountData", args: [borrower] }),
    client.readContract({ address: chain.aave.usdcVariableDebtToken, abi: erc20Abi, functionName: "balanceOf", args: [borrower] }),
  ]);
  const [collateralBase, debtBase, , , , hf] = account;
  return { kind: classifyDebt({ usdcVariableDebt, totalDebtBase: debtBase }), healthFactor: debtBase === 0n || hf === UINT_MAX ? null : hf, debtBase, collateralBase };
}
