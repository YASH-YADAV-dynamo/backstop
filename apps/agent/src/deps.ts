/**
 * Live wiring of AgentDeps: the policy's loan chain (Base or Arbitrum) via viem, NEAR via near-api-js, 1Click, NEAR AI, rescue store.
 * The agent has exactly one key (AGENT_PRIVATE_KEY): for `pnpm demo`, a function-call key for rescue,
 * fund_bridge and approve_pool on one policy; for the bot service, the bot account's key, shared by all
 * vaults through one NEAR submit queue (near-queue.ts). The vault accepts only those three methods from
 * the bot. The key is required lazily, so a dry run needs no key at all.
 */
import { teraToGas, type Account } from "near-api-js";
import { erc20Abi, type PublicClient } from "viem";
import { NEAR, POLICY, chainTxUrl, nearTxUrl, requireEnv, rpcList, type Env, type LoanChain } from "@backstop/config";
import {
  broadcastRaw,
  erc20Balance,
  feeEstimate,
  ftBalance,
  functionCall,
  l1DataFee,
  nearAccount,
  nearProvider,
  nonceOf,
  waitForReceipt,
} from "@backstop/chains";
import type { RescueStore } from "@backstop/db";
import { readPosition, usdcPriceBase, usdcVariableDebt } from "@backstop/lending-aave";
import {
  bridgeQuote,
  getStatus,
  oneClickOptionsFromEnv,
  pollStatus,
  quote,
  resolveUsdcAssets,
  submitDeposit,
  type UsdcAssets,
} from "@backstop/mover";
import { writeReceipt } from "@backstop/receipts";
import { parseBridgeFunded, parseRescueSigned, readPolicy, rescueJsonArgs, txJsonArgs } from "./policy.js";
import type { AgentDeps } from "./rescue.js";

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** NEAR rejects a function-call key whose allowance ran out; say how to fix it. */
function explainAgentKeyError(err: unknown): never {
  const msg = errText(err);
  if (/NotEnoughAllowance|allowance/i.test(msg)) {
    throw new Error(`${msg}\nThe agent key's NEAR allowance is used up: top up the agent key allowance (delete and re-add the key).`);
  }
  throw err;
}

/** A change call on the policy with the bot key: tx hash + decoded return value. */
export type PolicyCaller = (policyId: string, methodName: string, args: Record<string, string>, tgas: number) => Promise<{ txHash: string; result: unknown }>;

export interface LiveDepsOptions {
  /** The vault to serve (default POLICY_CONTRACT_ID). The bot service passes each vault's id. */
  policyId?: string;
  /** How policy calls are sent (default: a near-api-js Account for AGENT_ACCOUNT_ID). The service passes its NEAR submit queue. */
  callPolicy?: PolicyCaller;
}

export function liveDeps(
  env: Env,
  client: PublicClient,
  chain: LoanChain,
  store: RescueStore,
  log: (line: string) => void,
  opts: LiveDepsOptions = {},
): AgentDeps {
  const policyId = opts.policyId ?? requireEnv(env, ["POLICY_CONTRACT_ID"], "The agent").POLICY_CONTRACT_ID;
  const nearUrls = rpcList(env.NEAR_RPC_URL, NEAR.rpcUrls);
  const provider = nearProvider(nearUrls);
  const oneClick = oneClickOptionsFromEnv(env);

  let assets: UsdcAssets | undefined;
  const usdcAssets = async () => (assets ??= await resolveUsdcAssets(chain, oneClick));

  let agent: Account | undefined;
  const agentAccount = () => {
    if (!agent) {
      const e = requireEnv(env, ["AGENT_ACCOUNT_ID", "AGENT_PRIVATE_KEY"], "A live run (use --dry-run to try without keys)");
      agent = nearAccount(e.AGENT_ACCOUNT_ID, e.AGENT_PRIVATE_KEY, nearUrls);
    }
    return agent;
  };
  const send: PolicyCaller =
    opts.callPolicy ?? ((contractId, methodName, args, tgas) => functionCall(agentAccount(), { contractId, methodName, args, gas: teraToGas(tgas) }));
  const callPolicy = async (methodName: string, args: Record<string, string>, tgas: number) =>
    send(policyId, methodName, args, tgas).catch(explainAgentKeyError);

  return {
    policyId,
    now: () => new Date(),
    log,
    readPolicy: () => readPolicy(provider, policyId),
    readPosition: (user) => readPosition(client, chain.aave, user),
    usdcPrice: () => usdcPriceBase(client, chain.aave),
    usdcDebt: (user) => usdcVariableDebt(client, chain.aave, user),
    usdcBalance: (o) => erc20Balance(client, chain.aave.usdc, o),
    usdcAllowance: (o, spender) =>
      client.readContract({ address: chain.aave.usdc, abi: erc20Abi, functionName: "allowance", args: [o, spender] }),
    ethBalance: (address) => client.getBalance({ address }),
    policyUsdc: () => ftBalance(provider, NEAR.usdcToken, policyId),
    nonce: (address) => nonceOf(client, address),
    fees: () => feeEstimate(client),
    estimateGas: ({ from, to, data }) => client.estimateGas({ account: from, to, data, value: 0n }),
    l1Fee: ({ from, to, data }) => l1DataFee(client, chain, { from, to, data, value: 0n }),

    dryQuote: async (amountIn, recipient) => {
      const q = await quote({ dry: true, amountIn, recipient, refundTo: policyId, assets: await usdcAssets() }, oneClick);
      return { minAmountOut: q.minAmountOut, timeEstimate: q.timeEstimate };
    },
    bridgeQuote: (amountIn, recipient) => bridgeQuote({ amountIn, recipient, destAsset: chain.usdcAssetId, refundTo: policyId }, oneClick),
    fundBridge: async (q) => {
      const res = await callPolicy("fund_bridge", { quote: q.canonical, signature: q.signature }, POLICY.gas.fundBridge);
      return { nearTxHash: res.txHash, funded: parseBridgeFunded(res.result) };
    },
    submitDeposit: async (txHash, depositAddress) => {
      await submitDeposit({ txHash, depositAddress, nearSenderAccount: policyId }, oneClick);
    },
    bridgeStatus: async (depositAddress) => (await getStatus(depositAddress, oneClick)).status,
    pollBridge: async (depositAddress) => {
      const final = await pollStatus(depositAddress, { onUpdate: (u) => log(`1Click: ${u.status}`) }, oneClick);
      const fundsTx = final.destinationTxs[0]?.explorerUrl;
      return {
        status: final.status,
        statusUrl: final.statusUrl,
        ...(fundsTx && { fundsTx }),
        ...(final.refundReason !== undefined && { refundReason: final.refundReason }),
      };
    },

    callApprove: async (args) => {
      const res = await callPolicy("approve_pool", txJsonArgs(args), POLICY.gas.rescue);
      return { nearTxHash: res.txHash, signed: parseRescueSigned(res.result) };
    },
    callRescue: async (args) => {
      const res = await callPolicy("rescue", rescueJsonArgs(args), POLICY.gas.rescue);
      return { nearTxHash: res.txHash, signed: parseRescueSigned(res.result) };
    },
    broadcast: (signedTx) => broadcastRaw(client, signedTx),
    receiptExists: (hash) =>
      client.getTransactionReceipt({ hash }).then(
        () => true,
        () => false,
      ),
    waitForReceipt: async (hash) => {
      await waitForReceipt(client, chain, hash);
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    store,
    writeReceipt: (record) => writeReceipt(record, env, { onFallback: (why) => log(`Receipt: template used (${why}).`) }),
    urls: { nearTx: nearTxUrl, chainTx: (hash) => chainTxUrl(chain, hash) },
    session: {},
  };
}
