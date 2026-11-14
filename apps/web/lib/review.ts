/**
 * What the ReviewDialog shows and sends (E.4). `prepare()` re-reads everything the action depends on
 * (E.5 "stale state"), validates it, and returns either a refusal with a reason or the exact
 * transaction(s). Nothing here signs or sends.
 */
import { formatUtc } from "@/lib/format";
import { chainAddressUrl, FEE, loanChainByKey, NEAR } from "@backstop/config/registry";
import { formatUsdc } from "@backstop/core";
import { encodeFunctionData, formatEther, formatUnits, getAddress, parseAbi, type Address, type Hex } from "viem";
import { chainLabel, resolveChain } from "@/lib/chain";
import { buildCreateBody, createDeposit, GAS_ALLOWANCE_YOCTO, MAX_VAULTS, nearText, returnedOnClose, type CreateVaultInput } from "@/lib/create-vault";
import { debtBlockReason } from "@/lib/debt";
import { readDebt, readEthBalance, readLoan } from "@/lib/loan-client";
import { PUBLIC_ENV } from "@/lib/public-env";
import { viewAccount } from "@/lib/near-rpc";
import { fetchInviteStatus, fetchOwnerRequests, inviteBlockReason } from "@/lib/vault-requests";
import {
  activateTx,
  closeTx,
  createAccountTx,
  depositUsdcTx,
  failedChecks,
  pauseTx,
  readExpectedCodeHash,
  readPolicy,
  readUsdcBalance,
  readUsdcStorage,
  registerOnUsdcTx,
  setAgentTx,
  setLimitsTx,
  setOnBehalfOfTx,
  unpauseTx,
  verifyPolicy,
  withdrawNearTx,
  withdrawTx,
  type Check,
  type NearTx,
  type PolicySnapshot,
} from "@/lib/policy-client";
import { isNearAccountId, parseDecimal, parseEvmAddress, parseLimits, parseUsdc, type LimitsInput } from "@/lib/validate";

export type Row = [label: string, value: string];

type Common = { fingerprint: string; sentence: string; rows: Row[]; dangers: string[]; notes: string[] };
export type PreparedNear = Common & { ok: true; network: "near"; txs: NearTx[] };
/** An EVM transaction from the connected wallet: ETH to the policy's loan-chain address (step 5) or a deposit to a 1Click address (E.9). */
export type PreparedEvm = Common & { ok: true; network: "evm"; chainId: number; to: Address; valueWei: bigint; data?: Hex };
/** A refusal. `nearShort` is set when the problem is too little NEAR in the signer's account: the total needed and what it has. */
export type Prepared = { ok: false; reason: string; nearShort?: { needYocto: bigint; haveYocto: bigint } } | PreparedNear | PreparedEvm;
export type ReviewRequest = {
  kind: string;
  prepare: () => Promise<Prepared>;
  /** Called synchronously right before the wallet is asked (redirect wallets may leave the page after it). */
  beforeSend?: () => void;
  /** Called when the user rejected in the wallet (nothing was sent). */
  onRejected?: () => void;
  /** Called once when the wallet reports the transaction succeeded. */
  onSuccess?: () => void;
  /** EVM only: called with the transaction hash as soon as the wallet submitted it (before it is mined). */
  onSubmitted?: (hash: string) => void;
};

const MIN_NEAR_YOCTO = 10n ** 22n; // 0.01 NEAR: enough for gas of one owner call
const near = (yocto: bigint) => `${Number(formatUnits(yocto, 24)).toLocaleString("en-US", { maximumFractionDigits: 5 })} NEAR`;
const refuse = (reason: string): Prepared => ({ ok: false, reason });
const refuseShortOfNear = (reason: string, needYocto: bigint, haveYocto: bigint): Prepared => ({ ok: false, reason, nearShort: { needYocto, haveYocto } });

type Fresh = { snap: PolicySnapshot; checks: Check[] };

/** `owner`: the connected account, checked as the vault's owner; the Backstop bot is checked as its agent. */
async function fresh(policyId: string, owner?: string): Promise<Fresh> {
  const snap = await readPolicy(policyId);
  const checks = verifyPolicy(snap, await readExpectedCodeHash().catch(() => null), { owner: owner ?? null, agent: PUBLIC_ENV.agentId ?? null });
  return { snap, checks };
}

const checkSig = (checks: Check[]) => checks.map((c) => `${c.id}:${c.state}`).join(",");

/** The policy's chain name for copy (a chain we do not run is named by its id, never guessed). */
const chainName = (f: Fresh): string => resolveChain(f.snap.config.chain_id)?.name ?? `chain ${f.snap.config.chain_id}`;

/** NEAR rows plus the loan chain, so the user sees which policy (and so which chain) they are touching. */
const policyRows = (tx: NearTx[], f: Fresh): Row[] => [...nearRows(tx), ["Loan chain", chainName(f)]];

function ownerRefusal(f: Fresh, owner: string): string | null {
  return f.snap.config.owner === owner
    ? null
    : `Connected as ${owner}, but this policy's owner is ${f.snap.config.owner}. Switch accounts in your NEAR wallet.`;
}

function fundingRefusal(f: Fresh): string | null {
  const bad = failedChecks(f.checks);
  return bad.length ? `This policy is not safe to fund: ${bad.map((c) => c.label).join(", ")} failed verification.` : null;
}

function nearRows(tx: NearTx[]): Row[] {
  const rows: Row[] = [["Network", "NEAR mainnet"]];
  for (const t of tx) {
    rows.push(["Contract", t.receiverId]);
    for (const c of t.calls) {
      rows.push(["Method", c.methodName]);
      rows.push(["Attached deposit", depositText(c.depositYocto)]);
      rows.push(["Gas", `${c.gasTgas} TGas`]);
    }
  }
  return rows;
}

function depositText(yocto: string): string {
  if (yocto === "0") return "none";
  if (yocto === "1") return "1 yoctoNEAR (a formality NEAR requires for this kind of call)";
  return near(BigInt(yocto));
}

export function prepareDeposit(policyId: string, owner: string, amountText: string): Promise<Prepared> {
  return (async (): Promise<Prepared> => {
    const amount = parseUsdc(amountText, "The deposit amount");
    if (!amount.ok) return refuse(amount.error);
    const f = await fresh(policyId, owner);
    const refusal = ownerRefusal(f, owner) ?? fundingRefusal(f);
    if (refusal) return refuse(refusal);
    const [balance, storage, account] = await Promise.all([readUsdcBalance(owner), readUsdcStorage(policyId), viewAccount(owner)]);
    if (amount.value > balance) return refuse(`You have ${formatUsdc(balance)} USDC on NEAR; you asked to deposit ${formatUsdc(amount.value)}.`);
    const register = storage === null;
    const needNear = MIN_NEAR_YOCTO + (register ? BigInt(NEAR.usdcStorageDeposit) : 0n);
    const have = account?.amount ?? 0n;
    if (have < needNear) return refuseShortOfNear(`You need about ${near(needNear)} in your NEAR wallet for gas${register ? " and the one-time token registration" : ""}; you have ${near(have)}. Top up your NEAR wallet.`, needNear, have);
    const txs = [depositUsdcTx(policyId, amount.value, register)];
    return {
      ok: true,
      network: "near",
      txs,
      fingerprint: `d|${balance}|${register}|${checkSig(f.checks)}`,
      sentence: `Deposit ${formatUsdc(amount.value)} USDC from ${owner} into your policy ${policyId}`,
      rows: [...policyRows(txs, f), ["Receiver of the USDC", policyId], ["Amount", `${formatUsdc(amount.value)} USDC`]],
      dangers: [],
      notes: register ? [`Your policy is not registered on the USDC token yet, so this one transaction also registers it (${near(BigInt(NEAR.usdcStorageDeposit))}, one time).`] : [],
    };
  })();
}

export function prepareWithdraw(policyId: string, owner: string, amountText: string): Promise<Prepared> {
  return (async (): Promise<Prepared> => {
    const amount = parseUsdc(amountText, "The withdrawal amount");
    if (!amount.ok) return refuse(amount.error);
    const f = await fresh(policyId);
    const refusal = ownerRefusal(f, owner);
    if (refusal) return refuse(refusal);
    const [balance, ownerStorage, account] = await Promise.all([readUsdcBalance(policyId), readUsdcStorage(owner), viewAccount(owner)]);
    if (amount.value > balance) return refuse(`The policy holds ${formatUsdc(balance)} USDC; you asked to withdraw ${formatUsdc(amount.value)}.`);
    const needRegister = ownerStorage === null;
    const have = account?.amount ?? 0n;
    const needNear = MIN_NEAR_YOCTO + (needRegister ? BigInt(NEAR.usdcStorageDeposit) : 0n);
    if (have < needNear) return refuseShortOfNear(`You need about ${near(needNear)} in your NEAR wallet; you have ${near(have)}. Top up your NEAR wallet.`, needNear, have);
    const txs: NearTx[] = [...(needRegister ? [registerOnUsdcTx(owner)] : []), withdrawTx(policyId, amount.value)];
    return {
      ok: true,
      network: "near",
      txs,
      fingerprint: `w|${balance}|${needRegister}`,
      sentence: `Withdraw ${formatUsdc(amount.value)} USDC from your policy ${policyId} to ${owner}`,
      rows: [...policyRows(txs, f), ["USDC goes to", owner], ["Amount", `${formatUsdc(amount.value)} USDC`]],
      dangers: [],
      notes: needRegister
        ? [`Your account is not registered on the USDC token, so your wallet will ask you to approve two transactions: first a one-time registration (${near(BigInt(NEAR.usdcStorageDeposit))}), then the withdrawal.`]
        : [],
    };
  })();
}

export function preparePause(policyId: string, owner: string): Promise<Prepared> {
  return (async (): Promise<Prepared> => {
    const f = await fresh(policyId);
    const refusal = ownerRefusal(f, owner);
    if (refusal) return refuse(refusal);
    if (f.snap.limits.paused) return refuse("The policy is already paused.");
    const txs = [pauseTx(policyId)];
    return {
      ok: true,
      network: "near",
      txs,
      fingerprint: "p|running",
      sentence: `Pause rescues on your policy ${policyId}`,
      rows: policyRows(txs, f),
      dangers: [],
      notes: ["While paused the agent cannot rescue or bridge. Your loan is not protected until you unpause."],
    };
  })();
}

export function prepareUnpause(policyId: string, owner: string): Promise<Prepared> {
  return (async (): Promise<Prepared> => {
    const f = await fresh(policyId);
    const refusal = ownerRefusal(f, owner);
    if (refusal) return refuse(refusal);
    if (!f.snap.limits.paused) return refuse("The policy is not paused.");
    const txs = [unpauseTx(policyId)];
    return {
      ok: true,
      network: "near",
      txs,
      fingerprint: "u|paused",
      sentence: `Resume rescues on your policy ${policyId}`,
      rows: policyRows(txs, f),
      dangers: [`The agent will be able to spend up to ${formatUsdc(f.snap.limits.daily_cap)} USDC per day (${formatUsdc(f.snap.limits.max_per_rescue)} per rescue) from your policy.`],
      notes: [],
    };
  })();
}

export function prepareSetLimits(policyId: string, owner: string, input: LimitsInput): Promise<Prepared> {
  return (async (): Promise<Prepared> => {
    const parsed = parseLimits(input);
    if (!parsed.ok) return refuse(parsed.error);
    const f = await fresh(policyId);
    const refusal = ownerRefusal(f, owner);
    if (refusal) return refuse(refusal);
    const next = parsed.value;
    const cur = f.snap.limits;
    const txs = [setLimitsTx(policyId, next)];
    const dangers: string[] = [];
    const raises = BigInt(next.daily_cap) > cur.daily_cap || BigInt(next.max_per_rescue) > cur.max_per_rescue;
    if (raises) {
      dangers.push(`This raises what the agent can spend: up to ${formatUsdc(BigInt(next.daily_cap))} USDC per day and ${formatUsdc(BigInt(next.max_per_rescue))} USDC per rescue.`);
    }
    return {
      ok: true,
      network: "near",
      txs,
      fingerprint: `l|${JSON.stringify(cur, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))}`,
      sentence: `Change the limits of your policy ${policyId}`,
      rows: [
        ...policyRows(txs, f),
        ["Rescue when HF below", (next.trigger_hf_bps / 10_000).toFixed(2)],
        ["Repay up to HF", (next.target_hf_bps / 10_000).toFixed(2)],
        ["Max per rescue", `${formatUsdc(BigInt(next.max_per_rescue))} USDC`],
        ["Daily cap", `${formatUsdc(BigInt(next.daily_cap))} USDC`],
        ["Cooldown", `${next.cooldown_secs} seconds`],
        ["Max fee per gas", `${formatUnits(BigInt(next.max_fee_per_gas), 9)} gwei`],
        ["Max gas limit", next.max_gas_limit],
      ],
      dangers,
      notes: [],
    };
  })();
}

/** Mirrors the contract: `withdraw_near` keeps storage cost plus 0.2 NEAR (`MIN_NEAR_RESERVE`). */
const NEAR_RESERVE_YOCTO = 2n * 10n ** 23n;
/** Mirrors `CLOSE_QUIET_SECS` and `CLOSE_MAX_USDC_DUST` in the contract. */
const CLOSE_QUIET_SECS = 3_600;
const CLOSE_MAX_USDC_DUST = 9_999n;
const STORAGE_BYTE_COST_YOCTO = 10n ** 19n;

export function prepareWithdrawNear(policyId: string, owner: string, amountText: string): Promise<Prepared> {
  return (async (): Promise<Prepared> => {
    const amount = parseDecimal(amountText, 24, "The NEAR amount");
    if (!amount.ok) return refuse(amount.error);
    const f = await fresh(policyId);
    const refusal = ownerRefusal(f, owner);
    if (refusal) return refuse(refusal);
    const keep = BigInt(f.snap.account.storageUsage) * STORAGE_BYTE_COST_YOCTO + NEAR_RESERVE_YOCTO;
    const available = f.snap.account.amount > keep ? f.snap.account.amount - keep : 0n;
    if (amount.value > available) {
      return refuse(`The policy can send you at most ${near(available)} (it keeps its storage cost plus 0.2 NEAR for bridge registrations). To get everything back, close the policy instead.`);
    }
    const txs = [withdrawNearTx(policyId, amount.value)];
    return {
      ok: true,
      network: "near",
      txs,
      fingerprint: `wn|${f.snap.account.amount}`,
      sentence: `Withdraw ${near(amount.value)} from your policy ${policyId} to ${owner}`,
      rows: [...policyRows(txs, f), ["NEAR goes to", owner], ["Amount", near(amount.value)]],
      dangers: [],
      notes: ["Keep some NEAR in the policy: it pays the one-time token registration of each bridge."],
    };
  })();
}

export function prepareSetAgent(policyId: string, owner: string, agentText: string): Promise<Prepared> {
  return (async (): Promise<Prepared> => {
    const agent = agentText.trim();
    if (!isNearAccountId(agent)) return refuse("The agent must be a NEAR account id like agent.near.");
    const f = await fresh(policyId);
    const refusal = ownerRefusal(f, owner);
    if (refusal) return refuse(refusal);
    if (agent === f.snap.config.agent) return refuse("That account is already the agent.");
    const txs = [setAgentTx(policyId, agent)];
    return {
      ok: true,
      network: "near",
      txs,
      fingerprint: `sa|${f.snap.config.agent}`,
      sentence: `Make ${agent} the agent of your policy ${policyId} (replaces ${f.snap.config.agent})`,
      rows: [...policyRows(txs, f), ["Old agent", f.snap.config.agent], ["New agent", agent]],
      dangers: [`${agent} will be able to move up to ${formatUsdc(f.snap.limits.daily_cap)} USDC per day through your policy (only to its own loan-chain address, to repay your loan). Only name an account you control or trust.`],
      notes: ["The old agent loses access at once. The new agent still needs its own function-call key on the policy."],
    };
  })();
}

export function prepareSetBorrower(policyId: string, owner: string, addressText: string): Promise<Prepared> {
  return (async (): Promise<Prepared> => {
    const address = parseEvmAddress(addressText);
    if (!address.ok) return refuse(address.error);
    const f = await fresh(policyId);
    const refusal = ownerRefusal(f, owner);
    if (refusal) return refuse(refusal);
    if (getAddress(f.snap.config.on_behalf_of) === address.value) return refuse("That address is already the borrower.");
    const txs = [setOnBehalfOfTx(policyId, address.value)];
    return {
      ok: true,
      network: "near",
      txs,
      fingerprint: `sb|${f.snap.config.on_behalf_of}`,
      sentence: `Repay the Aave debt of ${address.value} on ${chainName(f)} instead of ${f.snap.config.on_behalf_of}`,
      rows: [...policyRows(txs, f), [`Old borrower (on ${chainName(f)})`, f.snap.config.on_behalf_of], [`New borrower (on ${chainName(f)})`, address.value]],
      dangers: ["Every future rescue repays THIS address's debt. Check the address character by character: repaying someone else's loan cannot be undone."],
      notes: [],
    };
  })();
}

export function prepareClose(policyId: string, owner: string): Promise<Prepared> {
  return (async (): Promise<Prepared> => {
    const f = await fresh(policyId);
    const refusal = ownerRefusal(f, owner);
    if (refusal) return refuse(refusal);
    if (!f.snap.limits.paused) return refuse("Pause the policy first, then close it.");
    const s = f.snap.status;
    const lastRequest = Math.max(Number(s.last_rescue_at), Number(s.last_bridge_at), Number(s.last_approve_at));
    const readyAt = lastRequest + CLOSE_QUIET_SECS;
    const nowSecs = Math.floor(Date.now() / 1000);
    if (lastRequest > 0 && nowSecs < readyAt) {
      return refuse(`The policy handled a request ${Math.ceil((nowSecs - lastRequest) / 60)} minutes ago. Wait until ${formatUtc(new Date(readyAt * 1000).toISOString())} (one hour after the last rescue, approval or bridge request), then close.`);
    }
    if (f.snap.usdcBalance > CLOSE_MAX_USDC_DUST) return refuse(`The policy still holds ${formatUsdc(f.snap.usdcBalance)} USDC. Withdraw it first, then close.`);
    const derived = f.snap.config.base_address;
    const chain = resolveChain(f.snap.config.chain_id);
    if (!chain) return refuse(`This policy is on chain id ${f.snap.config.chain_id}, which this app cannot read, so closing is not safe from here. Check its address balances on a block explorer first.`);
    let loan: Awaited<ReturnType<typeof readLoan>>;
    try {
      loan = await readLoan(chain, derived === null ? null : getAddress(derived), getAddress(f.snap.config.on_behalf_of));
    } catch {
      return refuse(`Could not read the policy's ${chain.name} address balances, so closing is not safe right now. Try again in a moment.`);
    }
    const dangers = [
      "This deletes the policy for good. It cannot be reopened, and its agent stops working.",
      `All ${near(f.snap.account.amount)} held by the policy go to ${owner}.`,
    ];
    if (loan.usdc > 0n || loan.eth > 0n) {
      dangers.push(
        `Its ${chain.name} address ${derived ?? ""} still holds ${formatUsdc(loan.usdc)} USDC and ${formatEther(loan.eth)} ETH. Nothing can be swept out of it once the policy is gone, and the operator who created the policy name can re-create it and control that address. Let rescues use up the USDC, or do not close.`,
      );
    }
    const txs = [closeTx(policyId)];
    return {
      ok: true,
      network: "near",
      txs,
      fingerprint: `c|${f.snap.account.amount}|${loan.usdc}|${loan.eth}`,
      sentence: `Close your policy ${policyId} and send its NEAR to ${owner}`,
      rows: [...policyRows(txs, f), ["NEAR goes to", owner], ["NEAR returned", near(f.snap.account.amount)], ["USDC left in policy", `${formatUsdc(f.snap.usdcBalance)} USDC`]],
      dangers,
      notes: ["Closing can fail on a policy that has handled more than about 120 bridges; nothing changes if it does."],
    };
  })();
}

export function prepareActivate(policyId: string): Promise<Prepared> {
  return (async (): Promise<Prepared> => {
    const f = await fresh(policyId);
    if (f.snap.config.base_address !== null) return refuse("The policy is already activated.");
    const bad = failedChecks(f.checks);
    if (bad.length) return refuse(`Not activating: ${bad.map((c) => c.label).join(", ")} failed verification.`);
    const txs = [activateTx(policyId)];
    return {
      ok: true,
      network: "near",
      txs,
      fingerprint: "a|inactive",
      sentence: `Activate your policy ${policyId}: derive its EVM address from NEAR's signer`,
      rows: policyRows(txs, f),
      dangers: [],
      notes: ["Anyone can activate a policy. It only asks v1.signer for the address this policy controls."],
    };
  })();
}

export type EvmSender = { address: Address; chainId: number | undefined };

export function prepareGasTopUp(policyId: string, owner: string, sender: EvmSender | null, amountText: string): Promise<Prepared> {
  return (async (): Promise<Prepared> => {
    if (!sender) return refuse("Connect an EVM wallet first. Read-only mode cannot send ETH.");
    const amount = parseDecimal(amountText, 18, "The ETH amount");
    if (!amount.ok) return refuse(amount.error);
    const f = await fresh(policyId, owner);
    const refusal = ownerRefusal(f, owner) ?? fundingRefusal(f);
    if (refusal) return refuse(refusal);
    const chain = resolveChain(f.snap.config.chain_id);
    if (!chain) return refuse(`This policy is on chain id ${f.snap.config.chain_id}, which Backstop does not support.`);
    if (sender.chainId !== chain.chainId) return refuse(`Your wallet is not on ${chain.name}. Switch to ${chain.name}, then try again.`);
    const derived = f.snap.config.base_address;
    if (derived === null || f.snap.derivedAddress === null) return refuse(`The policy has no verified ${chain.name} address yet. Activate it first.`);
    const to = getAddress(derived);
    const balance = await readEthBalance(chain, sender.address);
    if (amount.value >= balance) return refuse(`Your wallet holds ${formatEther(balance)} ETH on ${chain.name}; you asked to send ${formatEther(amount.value)} plus network fees.`);
    const threeRescues = 3n * f.snap.limits.max_fee_per_gas * f.snap.limits.max_gas_limit;
    const l1Note = chain.l1Fee === "op-stack" ? ` Each rescue also pays a small L1 data fee (${chain.name} posts data to Ethereum).` : ` The L1 cost is already inside the gas price on ${chain.name}.`;
    return {
      ok: true,
      network: "evm",
      chainId: chain.chainId,
      to,
      valueWei: amount.value,
      fingerprint: `g|${derived}|${checkSig(f.checks)}`,
      sentence: `Send ${formatEther(amount.value)} ETH on ${chain.name} from ${sender.address} to your policy's ${chain.name} address`,
      rows: [
        ["Network", chainLabel(chain)],
        [`To (policy's ${chain.name} address)`, to],
        ["Explorer", chainAddressUrl(chain, to)],
        ["Amount", `${formatEther(amount.value)} ETH`],
        ["From", sender.address],
      ],
      dangers: [],
      notes: [`This ETH pays ${chain.name} gas for rescues. Three rescues at your fee cap can cost up to ${formatEther(threeRescues)} ETH.${l1Note}`],
    };
  })();
}

export type FundSendInput = {
  chainId: number;
  chainName: string;
  symbol: string;
  decimals: number;
  /** ERC-20 contract; null/undefined = the chain's native coin */
  contract: string | null | undefined;
  /** 1Click deposit address (from the signed quote) */
  depositAddress: string;
  /** smallest units of the origin token */
  amount: bigint;
  /** ISO */
  deadline: string;
  policyId: string;
};

const TRANSFER_ABI = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);

/** E.9: send the deposit from the connected EVM wallet to the 1Click address. Goes through the same ReviewDialog. */
export function prepareFundSend(sender: { address: Address; chainId: number | undefined } | null, input: FundSendInput): Promise<Prepared> {
  return (async (): Promise<Prepared> => {
    if (!sender) return refuse("Connect an EVM wallet first, or send from any wallet to the address shown.");
    if (sender.chainId !== input.chainId) return refuse(`Your wallet is not on ${input.chainName}. Switch networks, then try again.`);
    if (Date.parse(input.deadline) <= Date.now()) return refuse("This deposit address has expired. Request a new quote; funds sent to an expired address may need a refund.");
    if (!/^0x[0-9a-fA-F]{40}$/.test(input.depositAddress)) return refuse("The deposit address is not an EVM address, so it cannot be sent from an EVM wallet.");
    const deposit = getAddress(input.depositAddress);
    const human = `${formatUnits(input.amount, input.decimals)} ${input.symbol}`;
    const base = {
      ok: true as const,
      network: "evm" as const,
      chainId: input.chainId,
      fingerprint: `f|${input.depositAddress}|${input.amount}`,
      sentence: `Send ${human} on ${input.chainName} from ${sender.address} to the 1Click deposit address; it arrives in ${input.policyId} as NEAR USDC`,
      dangers: [`Send exactly ${human} on ${input.chainName}. A different token, another chain, or a late deposit can lose funds or trigger a refund.`],
      notes: [`Deposit address valid until ${formatUtc(input.deadline)}.`],
    };
    // The registry knows explorers only for loan chains; for any other origin chain the wallet shows its own.
    const originChain = resolveChain(input.chainId);
    const explorerRow = (address: string): Row[] => (originChain ? [["Explorer", chainAddressUrl(originChain, address)]] : []);
    if (!input.contract) {
      return {
        ...base,
        to: deposit,
        valueWei: input.amount,
        rows: [["Network", `${input.chainName} (chain id ${input.chainId})`], ["To (1Click deposit address)", deposit], ...explorerRow(deposit), ["Amount", human], ["From", sender.address]],
      };
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(input.contract)) return refuse(`${input.symbol} has no EVM token contract in 1Click's list. Send it from your wallet by hand to the address shown.`);
    const token = getAddress(input.contract);
    return {
      ...base,
      to: token,
      valueWei: 0n,
      data: encodeFunctionData({ abi: TRANSFER_ABI, functionName: "transfer", args: [deposit, input.amount] }),
      rows: [
        ["Network", `${input.chainName} (chain id ${input.chainId})`],
        ["Token contract (the transaction goes here)", token],
        ...explorerRow(token),
        ["Method", "transfer"],
        ["Recipient (1Click deposit address)", deposit],
        ["Amount", human],
        ["From", sender.address],
      ],
    };
  })();
}

/**
 * Factory-less creation, step 1 of 2 (the only step the wallet signs): `near.create_account` makes the vault
 * account with Backstop's setup key and the refundable deposit. Re-reads the loan, the balance and the owner's
 * vaults, refuses on any problem, then shows exactly what will be sent. The bot does step 2 (install the vault
 * contract and delete the setup key, in one transaction).
 */
export function prepareCreateVault(owner: string, input: CreateVaultInput): Promise<Prepared> {
  return (async (): Promise<Prepared> => {
    const { vaultDeployerPk, policyCodeBytes, policyCodeHash, agentId } = PUBLIC_ENV;
    const deposit = createDeposit(policyCodeBytes);
    if (!vaultDeployerPk || !policyCodeHash || !agentId || deposit === null) return refuse("Vault creation opens soon.");
    // Invite check BEFORE anything reaches the wallet: the create call attaches NEAR, and a server refusal
    // after signing would strand it. Fails closed when the answer cannot be had.
    const invite = await fetchInviteStatus(owner).catch((): "error" => "error");
    const notInvited = inviteBlockReason(owner, invite);
    if (notInvited) return refuse(notInvited);
    const built = await buildCreateBody(owner, input);
    if (!built.ok) return refuse(built.error);
    const body = built.value;
    const chain = loanChainByKey(body.chainKey);
    const [debt, account, requests, taken] = await Promise.all([readDebt(chain, getAddress(body.borrower)), viewAccount(owner), fetchOwnerRequests(owner), viewAccount(body.vaultId)]);
    if (taken !== null) return refuse("This vault name is already taken. Close this window and press Create again for a new one.");
    const blocked = debtBlockReason(debt.kind);
    if (blocked) return refuse(blocked);
    const open = requests.filter((r) => r.status !== "failed" && r.status !== "aborted");
    if (open.length >= MAX_VAULTS) return refuse(`You've reached the limit of ${MAX_VAULTS} vaults. Close one to open another.`);
    const have = account?.amount ?? 0n;
    if (have < deposit + GAS_ALLOWANCE_YOCTO) {
      return refuseShortOfNear(`Opening a vault holds about ${nearText(deposit, 2)}; you have ${nearText(have, 2)}. You get it back when you close the vault.`, deposit + GAS_ALLOWANCE_YOCTO, have);
    }
    const txs = [createAccountTx(body.vaultId, vaultDeployerPk, deposit)];
    const l = body.limits;
    return {
      ok: true,
      network: "near",
      txs,
      fingerprint: `cv|${body.vaultId}|${deposit}|${debt.kind}|${open.length}`,
      sentence: `Create your Rescue vault on ${chain.name}.`,
      rows: [
        ...nearRows(txs),
        ["New vault account", body.vaultId],
        ["Setup key added to it", vaultDeployerPk],
        ["Loan chain", chain.name],
        [`Loan address on ${chain.name}`, body.borrower],
        ["Rescue at health", (l.trigger_hf_bps / 10_000).toFixed(2)],
        ["Most per rescue", `${formatUsdc(BigInt(l.max_per_rescue))} USDC`],
        ["Most per day", `${formatUsdc(BigInt(l.daily_cap))} USDC`],
        ["Rescue bot", agentId],
        ["Service fee", `at most ${(FEE.maxBps / 100).toFixed(2)}% of bridged amounts (the contract's cap; your vault page shows the exact rate)`],
        ["Vault owner", owner],
        ["Refundable deposit", `${nearText(deposit, 3)}, returned to you when you close the vault (at least ${nearText(returnedOnClose(deposit), 3)})`],
      ],
      dangers: [],
      notes: [
        `Refundable deposit: ${nearText(deposit, 3)}. This keeps your vault on NEAR. You get it back when you close your vault.`,
        "Your wallet creates the vault account with Backstop's setup key. Within about a minute Backstop's bot installs the vault contract and deletes that key in the same transaction; after that your vault has no keys, so nobody, Backstop included, can change how it works.",
        "If setup fails, the bot deletes the account and your NEAR goes back to your wallet.",
      ],
    };
  })();
}
