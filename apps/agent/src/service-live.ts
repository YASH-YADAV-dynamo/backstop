/**
 * Live wiring of the bot service (`pnpm --filter @backstop/agent start`). One bot NEAR account
 * (AGENT_ACCOUNT_ID, key AGENT_PRIVATE_KEY from the host secret store) serves every admitted vault
 * through one NEAR submit queue; each vault's repay is signed by its own rescue wallet, so EVM
 * nonces never collide across vaults, and the per-vault lock covers approve then repay.
 */
import { baseDecode } from "near-api-js";
import { erc20Abi, getAddress, toHex, type Address, type PublicClient } from "viem";
import { NEAR, loanChainById, rpcList, type Env, type LoanChain } from "@backstop/config";
import { assertChainId, evmClient, feeEstimate, ftBalance, l1DataFee, nearProvider, viewAccessKeys, viewCall } from "@backstop/chains";
import type { RescueStore, VaultStatusStore } from "@backstop/db";
import { encodeRepay, poolAbi } from "@backstop/lending-aave";
import { deriveAddressOnChain, deriveEvmAddress } from "@backstop/signer";
import { liveDeps } from "./deps.js";
import { admitVault, discoverVaults, readFactory, type AdmitIO, type ViewFn } from "./discover.js";
import { NearSubmitQueue, nearKeyClient } from "./near-queue.js";
import { readPolicy } from "./policy.js";
import { IN_PROGRESS, resumeSignedRepay, runOnce, type AgentDeps, type RunOptions } from "./rescue.js";
import type { Alert, ServiceIO, TaskKind, TaskResult, Vault } from "./service.js";
import type { LoanRead } from "./status.js";

const multicall3EthAbi = [
  {
    type: "function",
    name: "getEthBalance",
    stateMutability: "view",
    inputs: [{ name: "addr", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
] as const;

/** Vaults per Multicall3 request (5 reads each). */
const MULTICALL_CHUNK = 200;
const CALLS_PER_VAULT = 5;

/** Batched loan reads for every vault on one chain: Multicall3 aggregate3 with allowFailure. */
export async function readLoansMulticall(client: PublicClient, chain: LoanChain, vaults: readonly Vault[]): Promise<Map<string, LoanRead | Error>> {
  const multicall3 = client.chain?.contracts?.multicall3?.address;
  if (!multicall3) throw new Error(`No Multicall3 address known for ${chain.name}.`);
  const out = new Map<string, LoanRead | Error>();
  for (let i = 0; i < vaults.length; i += MULTICALL_CHUNK) {
    const chunk = vaults.slice(i, i + MULTICALL_CHUNK);
    const contracts = chunk.flatMap((v) => {
      const borrower = v.config.onBehalfOf;
      const wallet = v.config.baseAddress;
      return [
        { address: chain.aave.pool, abi: poolAbi, functionName: "getUserAccountData", args: [borrower] },
        { address: chain.aave.usdcVariableDebtToken, abi: erc20Abi, functionName: "balanceOf", args: [borrower] },
        { address: chain.aave.usdc, abi: erc20Abi, functionName: "balanceOf", args: [wallet] },
        { address: chain.aave.usdc, abi: erc20Abi, functionName: "allowance", args: [wallet, chain.aave.pool] },
        { address: multicall3, abi: multicall3EthAbi, functionName: "getEthBalance", args: [wallet] },
      ] as const;
    });
    const results = (await client.multicall({ contracts, allowFailure: true, batchSize: 0 })) as { status: "success" | "failure"; result?: unknown; error?: Error }[];
    chunk.forEach((v, j) => {
      const r = results.slice(j * CALLS_PER_VAULT, (j + 1) * CALLS_PER_VAULT);
      const failed = r.find((x) => x.status !== "success");
      if (failed || r.length !== CALLS_PER_VAULT) {
        out.set(v.policyId, new Error(failed?.error?.message.split("\n")[0] ?? "multicall returned too few results"));
        return;
      }
      const [acct, usdcDebt, walletUsdc, allowance, gasWei] = r.map((x) => x.result) as [readonly bigint[], bigint, bigint, bigint, bigint];
      const [totalCollateralBase, totalDebtBase, availableBorrowsBase, currentLiquidationThreshold, ltv, healthFactor] = acct as [bigint, bigint, bigint, bigint, bigint, bigint];
      out.set(v.policyId, {
        position: { totalCollateralBase, totalDebtBase, availableBorrowsBase, currentLiquidationThreshold, ltv, healthFactor },
        usdcDebt,
        walletUsdc,
        allowance,
        gasWei,
      });
    });
  }
  return out;
}

/** POST a JSON body Discord (`content`) and Slack-style (`text`) webhooks both accept. Never keys. */
export async function postAlert(url: string, a: Alert): Promise<void> {
  const text = `[backstop bot] ${a.kind}: ${a.text}`.slice(0, 1900);
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: text, text }) });
  if (!res.ok) throw new Error(`webhook answered HTTP ${res.status}`);
}

/** NEAR shows code hashes in base58; the factory's policy_code_hash() is hex. */
export const codeHashToHex = (base58: string) => toHex(baseDecode(base58)).slice(2);

export interface LiveServiceSetup {
  io: ServiceIO;
  /** The factory's default_agent, to warn when it is not this bot. */
  factoryDefaultAgent: string | null;
}

export async function liveServiceIO(
  env: Env & { AGENT_ACCOUNT_ID: string },
  store: RescueStore,
  statusStore: VaultStatusStore,
  log: (line: string) => void,
  run: RunOptions,
): Promise<LiveServiceSetup> {
  const nearUrls = rpcList(env.NEAR_RPC_URL, NEAR.rpcUrls);
  const provider = nearProvider(nearUrls);
  const view: ViewFn = (id, method, args) => viewCall<unknown>(provider, id, method, args ?? {});
  const bot = env.AGENT_ACCOUNT_ID;

  let codeHash: string | null = null;
  let factoryDefaultAgent: string | null = null;
  if (env.FACTORY_CONTRACT_ID) {
    const f = await readFactory(view, env.FACTORY_CONTRACT_ID);
    codeHash = f.codeHash;
    factoryDefaultAgent = f.defaultAgent;
  }
  const policyIds = [...(env.POLICY_CONTRACT_IDS ?? []), ...(env.POLICY_CONTRACT_ID ? [env.POLICY_CONTRACT_ID] : [])];

  // One client per loan chain, chain id checked once before first use.
  const clients = new Map<number, Promise<PublicClient>>();
  const clientFor = (chainId: number): Promise<PublicClient> => {
    let c = clients.get(chainId);
    if (!c) {
      const chain = loanChainById(chainId);
      const client = evmClient(chain, rpcList(env[chain.rpcEnvVar], chain.rpcUrls));
      c = assertChainId(client, chain).then(() => client);
      c.catch(() => clients.delete(chainId));
      clients.set(chainId, c);
    }
    return c;
  };

  let queue: NearSubmitQueue | undefined;
  const nearQueue = () => {
    if (!queue) {
      if (!env.AGENT_PRIVATE_KEY) throw new Error("A live service run needs AGENT_PRIVATE_KEY (the bot account key; use --dry-run to try without it).");
      queue = new NearSubmitQueue(nearKeyClient(provider, bot, env.AGENT_PRIVATE_KEY));
    }
    return queue;
  };

  const admitIO: AdmitIO = {
    readPolicy: (id) => readPolicy(provider, id),
    accessKeyCount: async (id) => (await viewAccessKeys(provider, id)).length,
    codeHashHex: async (id) => codeHashToHex(String((await provider.viewAccount({ accountId: id })).code_hash)),
    derive: async (chain, id) => {
      const [a, b] = await Promise.all([deriveEvmAddress(chain, id, NEAR.derivationPath), deriveAddressOnChain(provider, id, NEAR.derivationPath)]);
      return { chainsig: a.address, mpcView: b.address };
    },
  };

  // One AgentDeps per vault, kept across passes (its `session` holds a pending approve).
  const deps = new Map<string, Promise<AgentDeps>>();
  const depsFor = (v: Vault): Promise<AgentDeps> => {
    let d = deps.get(v.policyId);
    if (!d) {
      const chain = loanChainById(v.config.chainId);
      d = clientFor(chain.chainId).then((client) =>
        liveDeps(env, client, chain, store, (line) => log(`[${v.policyId}] ${line}`), {
          policyId: v.policyId,
          callPolicy: (receiverId, methodName, args, tgas) => nearQueue().call({ receiverId, methodName, args, tgas }),
        }),
      );
      d.catch(() => deps.delete(v.policyId));
      deps.set(v.policyId, d);
    }
    return d;
  };

  const io: ServiceIO = {
    now: () => new Date(),
    log,
    discover: () => discoverVaults(view, { factoryId: env.FACTORY_CONTRACT_ID, policyIds }),
    admit: (id) => admitVault(admitIO, id, { botAccountId: bot, codeHash }),
    readNear: async (id) => {
      const [{ limits }, usdcVault] = await Promise.all([readPolicy(provider, id), ftBalance(provider, NEAR.usdcToken, id)]);
      return { limits, usdcVault };
    },
    readLoans: async (chainId, vaults) => readLoansMulticall(await clientFor(chainId), loanChainById(chainId), vaults),
    chainFees: async (chainId) => {
      const chain = loanChainById(chainId);
      const client = await clientFor(chainId);
      // A representative repay (same calldata size) for the L1 data fee; the oracle only sizes the bytes.
      const sample: Address = getAddress(chain.aave.pool);
      const [fees, l1Fee] = await Promise.all([
        feeEstimate(client),
        l1DataFee(client, chain, { from: sample, to: sample, value: 0n, data: encodeRepay(chain.aave.usdc, 1_000_000n, sample) }),
      ]);
      return { maxFeePerGas: fees.maxFeePerGas, l1Fee };
    },
    pendingResumes: async () =>
      new Set(
        (await store.list())
          .filter((r) => r.policyId && r.signedTx && !r.links.baseRepayTx && r.error?.startsWith(IN_PROGRESS))
          .map((r) => r.policyId!),
      ),
    runTask: async (kind: TaskKind, v: Vault): Promise<TaskResult> => {
      const d = await depsFor(v);
      if (kind === "resume") {
        const record = await resumeSignedRepay(d, v.config);
        return record ? { record } : {};
      }
      const res = await runOnce(d, run);
      return { decision: res.decision, ...(res.record && { record: res.record }) };
    },
    statusStore,
    alert: async (a) => {
      log(`ALERT ${a.kind}: ${a.text}`);
      if (env.ALERT_WEBHOOK_URL) await postAlert(env.ALERT_WEBHOOK_URL, a);
    },
    botBalance: async () => BigInt((await provider.viewAccount({ accountId: bot })).amount),
    ...(env.HEARTBEAT_URL !== undefined && {
      heartbeat: async () => {
        const res = await fetch(env.HEARTBEAT_URL!);
        if (!res.ok) throw new Error(`heartbeat URL answered HTTP ${res.status}`);
      },
    }),
  };
  return { io, factoryDefaultAgent };
}
