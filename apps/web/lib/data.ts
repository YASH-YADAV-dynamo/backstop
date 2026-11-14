/**
 * Server-side reads for the dashboard: policy contract views (NEAR RPC), the borrower's Aave position and
 * the derived address's balances on the policy's loan chain (that chain's RPC), and the rescue history
 * (@backstop/db). The loan chain is always the policy's `chain_id` (D30), never a setting. Each section
 * fails independently and says what to fix; nothing here invents numbers.
 */
import { assertChainId, erc20Balance, evmClient } from "@backstop/chains";
import { chainAddressUrl, chainTxUrl, NEAR, ONE_CLICK, rpcList, loadWebEnv, nearTxUrl, SUPPORTED_CHAIN_NAMES, type LoanChain, type WebEnv } from "@backstop/config";
import { formatUsdc, hfToNumber, type RescueRecord } from "@backstop/core";
import { openStore } from "@backstop/db";
import { readPosition } from "@backstop/lending-aave";
import { factsOf, templateReceipt } from "@backstop/receipts";
import { formatEther, formatGwei, formatUnits, isAddress, type Address } from "viem";
import { ZodError } from "zod";
import type { DashboardSnapshot, PolicyView, PositionView, RescueRow, Section } from "@/lib/dashboard-types";
import { formatHf, formatUtc } from "@/lib/format";
import { resolveChain } from "@/lib/chain";
import { redactUrls } from "@/lib/redact";
import { configureNearRpc, NearRpcError } from "@/lib/near-rpc";
import { readExpectedCodeHash, readPolicy as readPolicyChain, verifyPolicy } from "@/lib/policy-client";

const RPC_TIMEOUT_MS = 10_000;

type EnvResult = { ok: true; env: WebEnv } | { ok: false; message: string };

function readEnv(): EnvResult {
  try {
    const env = loadWebEnv();
    configureNearRpc(rpcList(env.NEAR_RPC_URL, NEAR.rpcUrls));
    return { ok: true, env };
  } catch (err) {
    return { ok: false, message: errorMessage(err) };
  }
}

/**
 * These messages are served publicly by /api/dashboard. RPC and database errors can quote the
 * URL they called, and provider URLs carry API keys or passwords, so every URL is cut to its host.
 */
function errorMessage(err: unknown): string {
  return redactUrls(err instanceof Error ? err.message.split("\n").slice(0, 4).join(" ") : String(err));
}

function withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${RPC_TIMEOUT_MS / 1000}s`)), RPC_TIMEOUT_MS);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

const nearAccountUrl = (id: string) => `${NEAR.explorer}/address/${id}`;

const formatNear = (yocto: bigint) => Number(formatUnits(yocto, 24)).toLocaleString("en-US", { maximumFractionDigits: 3 });

async function readPolicy(contractId: string | undefined): Promise<Section<PolicyView>> {
  if (!contractId) {
    return {
      state: "unconfigured",
      envVar: "POLICY_CONTRACT_ID",
      message: "Set POLICY_CONTRACT_ID in .env to the NEAR account of a deployed policy contract, or open /dashboard?policy=<account id>.",
    };
  }
  try {
    const snap = await withTimeout(readPolicyChain(contractId), "NEAR RPC");
    const chain = resolveChain(snap.config.chain_id);
    if (!chain) {
      return {
        state: "error",
        message: `${contractId} protects a loan on chain id ${snap.config.chain_id}, which Backstop does not support (supported: ${SUPPORTED_CHAIN_NAMES}). Check the account id.`,
      };
    }
    const expected = await readExpectedCodeHash().catch(() => null);
    const { config, limits, status } = snap;
    const spentPct =
      limits.daily_cap === 0n ? 0 : Math.min(100, Number((status.spent_today * 10_000n) / limits.daily_cap) / 100);
    return {
      state: "ok",
      data: {
        contractId,
        chain: { id: chain.chainId, key: chain.key, name: chain.name, explorer: chain.explorer },
        contractUrl: nearAccountUrl(contractId),
        owner: config.owner,
        agent: config.agent,
        agentUrl: nearAccountUrl(config.agent),
        derivedAddress: config.base_address,
        derivedAddressUrl: config.base_address ? chainAddressUrl(chain, config.base_address) : null,
        borrower: config.on_behalf_of,
        borrowerUrl: chainAddressUrl(chain, config.on_behalf_of),
        usdcInPolicy: formatUsdc(snap.usdcBalance),
        nearInPolicy: formatNear(snap.account.amount),
        checks: verifyPolicy(snap, expected),
        bridge: {
          count: status.bridge_count,
          spentToday: formatUsdc(status.bridge_spent_today),
          remainingToday: formatUsdc(status.bridge_remaining_today),
          lastAt: Number(status.last_bridge_at),
          last: status.last_bridge
            ? {
                bridgeId: status.last_bridge.bridge_id,
                amountIn: formatUsdc(status.last_bridge.amount_in),
                minAmountOut: formatUsdc(status.last_bridge.min_amount_out),
                depositAddress: status.last_bridge.deposit_address,
                fundedAt: Number(status.last_bridge.funded_at),
              }
            : null,
        },
        mpcContract: config.mpc_contract,
        derivationPath: config.derivation_path,
        feeBps: config.fee_bps,
        feeAccount: config.fee_account,
        limits: {
          triggerHf: limits.trigger_hf_bps / 10_000,
          targetHf: limits.target_hf_bps / 10_000,
          maxPerRescue: formatUsdc(limits.max_per_rescue),
          dailyCap: formatUsdc(limits.daily_cap),
          cooldownSecs: Number(limits.cooldown_secs),
          maxFeePerGasGwei: formatGwei(limits.max_fee_per_gas),
          maxGasLimit: limits.max_gas_limit.toLocaleString("en-US"),
          paused: limits.paused,
        },
        status: {
          spentToday: formatUsdc(status.spent_today),
          remainingToday: formatUsdc(status.remaining_today),
          spentPct,
          lastRescueAt: Number(status.last_rescue_at),
          cooldownEndsAt: Number(status.cooldown_ends_at),
          rescueCount: status.rescue_count,
        },
      },
    };
  } catch (err) {
    if (err instanceof ZodError) {
      return {
        state: "error",
        message: `${contractId} answered, but not with the Backstop v2 policy views (${err.issues[0]?.path.join(".") || "shape"} mismatch). It may be an older policy or another contract: check the account id.`,
      };
    }
    if (err instanceof NearRpcError && err.kind === "rejected") {
      return { state: "error", message: `${errorMessage(err)}. If the account exists but is not a Backstop v2 policy, check the account id.` };
    }
    return { state: "error", message: errorMessage(err) };
  }
}

const usd8 = (x: bigint) =>
  Number(formatUnits(x, 8)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const bpsPct = (x: bigint) => (Number(x) / 100).toFixed(2);

async function readLoanPosition(env: WebEnv, policy: Section<PolicyView>): Promise<Section<PositionView>> {
  if (policy.state === "unconfigured") {
    return {
      state: "unconfigured",
      envVar: "POLICY_CONTRACT_ID",
      message: "The borrower and loan chain come from the policy contract (get_config). Set POLICY_CONTRACT_ID in .env first, or open /dashboard?policy=<account id>.",
    };
  }
  if (policy.state === "error") {
    return { state: "error", message: "Could not read the borrower and loan chain from the policy contract (see the policy error above)." };
  }
  const chain = resolveChain(policy.data.chain.id);
  if (!chain) {
    return { state: "error", message: `Chain id ${policy.data.chain.id} is not supported (supported: ${SUPPORTED_CHAIN_NAMES}).` };
  }
  const borrower = policy.data.borrower;
  const derived = policy.data.derivedAddress;
  if (!isAddress(borrower)) {
    return { state: "error", message: `The policy contract reports on_behalf_of "${borrower}", which is not an EVM address.` };
  }
  if (derived !== null && !isAddress(derived)) {
    return { state: "error", message: `The policy contract reports base_address "${derived}", which is not an EVM address.` };
  }
  try {
    const client = evmClient(chain, rpcList(env[chain.rpcEnvVar], chain.rpcUrls));
    const [position, usdc, eth] = await withTimeout(
      (async () => {
        // Refuse an RPC that serves another chain before reading anything from it.
        await assertChainId(client, chain);
        // The loan belongs to the borrower (on_behalf_of); only the balances live at the derived address.
        return Promise.all([
          readPosition(client, chain.aave, borrower as Address),
          derived === null ? Promise.resolve(null) : erc20Balance(client, chain.aave.usdc, derived as Address),
          derived === null ? Promise.resolve(null) : client.getBalance({ address: derived as Address }),
        ]);
      })(),
      `${chain.name} RPC`,
    );
    const hf = hfToNumber(position.healthFactor);
    return {
      state: "ok",
      data: {
        address: borrower,
        healthFactor: position.totalDebtBase === 0n || !Number.isFinite(hf) ? null : hf,
        collateralUsd: usd8(position.totalCollateralBase),
        debtUsd: usd8(position.totalDebtBase),
        availableBorrowUsd: usd8(position.availableBorrowsBase),
        liquidationThresholdPct: bpsPct(position.currentLiquidationThreshold),
        ltvPct: bpsPct(position.ltv),
        usdcBalance: usdc === null ? null : formatUsdc(usdc),
        ethBalance: eth === null ? null : Number(formatEther(eth)).toLocaleString("en-US", { maximumFractionDigits: 6 }),
      },
    };
  } catch (err) {
    const message = errorMessage(err);
    return { state: "error", message: message.includes(chain.rpcEnvVar) ? message : `${message}. Check ${chain.rpcEnvVar}.` };
  }
}

/** Records may hold a full URL or a bare hash / deposit address; always hand the UI a URL. */
function linkOf<K extends keyof RescueRow["links"]>(
  key: K,
  value: string | undefined,
  toUrl: ((v: string) => string) | null,
): Partial<Record<K, string>> {
  if (!value) return {};
  if (value.startsWith("http")) return { [key]: value } as Partial<Record<K, string>>;
  return toUrl ? ({ [key]: toUrl(value) } as Partial<Record<K, string>>) : {};
}

/** `chain` is the policy's loan chain; null (landing page) means a bare hash cannot be linked, a full URL still can. */
function toRow(r: RescueRecord, chain: LoanChain | null): RescueRow {
  const amount = /^\d+$/.test(r.amount) ? formatUsdc(BigInt(r.amount)) : r.amount;
  const row: RescueRow = {
    id: r.id,
    dryRun: r.dryRun,
    date: formatUtc(r.triggeredAt),
    hfBefore: formatHf(r.hfBefore),
    hfAfter: r.hfAfter === undefined ? null : formatHf(r.hfAfter),
    amountUsdc: amount,
    status: r.status,
    links: {
      ...linkOf("oneClickStatus", r.links.oneClickStatus, (d) => `${ONE_CLICK.baseUrl}/v0/status?depositAddress=${encodeURIComponent(d)}`),
      ...linkOf("nearRescueTx", r.links.nearRescueTx, nearTxUrl),
      ...linkOf("baseRepayTx", r.links.baseRepayTx, chain ? (hash) => chainTxUrl(chain, hash) : null),
    },
  };
  if (r.error) row.error = redactUrls(r.error);
  if (r.receipt) {
    // Records store where the receipt came from. For a record without that field, compare with the
    // deterministic template: a receipt that differs from it came from NEAR AI.
    const source = r.receiptSource
      ? r.receiptSource === "near-ai" ? "NEAR AI" : "template"
      : r.receipt === templateReceipt(factsOf(r)) ? "template" : "NEAR AI";
    row.receipt = { text: r.receipt, source };
  }
  return row;
}

/** Records carry the policy they belong to once the agent writes `policyId`; older records have none and belong to the default policy. */
function belongsTo(record: RescueRecord, policyId: string | undefined, isDefault: boolean): boolean {
  const owner = (record as { policyId?: unknown }).policyId;
  if (typeof owner === "string") return owner === policyId;
  return isDefault;
}

async function readHistory(env: WebEnv, policyId: string | undefined, chain: LoanChain | null): Promise<Section<RescueRow[]>> {
  const isDefault = policyId === undefined || policyId === env.POLICY_CONTRACT_ID;
  try {
    const store = await openStore(env);
    try {
      const records = (await store.list()).filter((r) => belongsTo(r, policyId, isDefault));
      return { state: "ok", data: records.map((r) => toRow(r, chain)).reverse() };
    } finally {
      await store.close();
    }
  } catch (err) {
    const where = env.DATABASE_URL ? "DATABASE_URL" : "RESCUES_FILE";
    return { state: "error", message: `${errorMessage(err)} (reading ${where})` };
  }
}

/** Rescue history only (the landing page's live proof). Newest first. */
export async function getHistory(): Promise<Section<RescueRow[]>> {
  const env = readEnv();
  if (!env.ok) return { state: "error", message: env.message };
  return readHistory(env.env, env.env.POLICY_CONTRACT_ID, null);
}

/** `policyParam` (already validated by the caller) overrides the server's default POLICY_CONTRACT_ID. */
export async function getDashboard(policyParam?: string): Promise<DashboardSnapshot> {
  const fetchedAt = new Date().toISOString();
  const env = readEnv();
  if (!env.ok) {
    const failed = { state: "error", message: env.message } as const;
    return { fetchedAt, policy: failed, position: failed, history: failed };
  }
  const policyId = policyParam ?? env.env.POLICY_CONTRACT_ID;
  const policy = await readPolicy(policyId);
  const chain = policy.state === "ok" ? resolveChain(policy.data.chain.id) : null;
  const [history, position] = await Promise.all([readHistory(env.env, policyId, chain), readLoanPosition(env.env, policy)]);
  return { fetchedAt, policy, position, history };
}
