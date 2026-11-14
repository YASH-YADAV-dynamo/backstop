/** Pure rules of the "Create my Rescue vault" card (K.6, v3 section 2): defaults, limits, the deposit, and when creating is blocked. */
import { DEPLOYER_GAS_RESERVE_YOCTO, MAX_VAULTS_PER_OWNER, vaultCreateDeposit } from "@backstop/config/vault-plan";
import { LOAN_CHAINS, NEAR } from "@backstop/config/registry";
import { vaultNameFor } from "@backstop/core";
import { formatUnits } from "viem";
import { parseEvmAddress, parseLimits, type LimitsInput, type LimitsJson, type Parsed } from "@/lib/validate";
import { debtBlockReason, type DebtKind } from "@/lib/debt";
import { inviteBlockReason, type CreateBody, type InviteStatus } from "@/lib/vault-requests";

/** The three fields people see. */
export type CreateFields = { triggerHf: string; maxPerRescue: string; dailyCap: string };

/** K.6 defaults for the three visible limits. */
export const DEFAULT_FIELDS: CreateFields = { triggerHf: "1.10", maxPerRescue: "5", dailyCap: "10" };

/** Hidden limits: the same values as `DEFAULT_LIMITS` in scripts/src/lib/limits.ts (a test pins them). */
export const HIDDEN_LIMITS = { targetHf: "1.30", cooldownSecs: "600", maxFeeGwei: "1", maxGasLimit: "400000" } as const;

/**
 * Part of the deposit that does not come back on close: the vault's USDC token registration (held by the
 * token contract) and, at most, the gas the deploy transaction burns. Everything else returns with the account.
 */
export const NOT_RETURNED_YOCTO = BigInt(NEAR.usdcStorageDeposit) + DEPLOYER_GAS_RESERVE_YOCTO;
/** Spare NEAR the owner's account needs on top of the deposit, for the wallet's own gas. */
export const GAS_ALLOWANCE_YOCTO = 50_000_000_000_000_000_000_000n;
/** Vaults per owner, counting ones still being created. */
export const MAX_VAULTS = MAX_VAULTS_PER_OWNER;

export const nearText = (yocto: bigint, digits = 3): string => `${Number(formatUnits(yocto, 24)).toLocaleString("en-US", { maximumFractionDigits: digits })} NEAR`;

/** The refundable deposit for the configured policy wasm; null while creation is not configured. */
export const createDeposit = (codeBytes: number | undefined): bigint | null => (codeBytes === undefined ? null : vaultCreateDeposit(codeBytes));

/** At least what the owner gets back on close (the account's whole balance goes to the owner). */
export const returnedOnClose = (deposit: bigint): bigint => (deposit > NOT_RETURNED_YOCTO ? deposit - NOT_RETURNED_YOCTO : 0n);

export type CreateVaultInput = { chainKey: string; loanAddress: string; fields: CreateFields; salt: string };

/**
 * The POST /api/vaults body for a create: validated fields plus the vault name they commit to. The salt is
 * chosen once per create (the review re-prepares every 15 s; the same salt keeps the same name).
 */
export async function buildCreateBody(owner: string, input: CreateVaultInput): Promise<Parsed<CreateBody>> {
  if (!LOAN_CHAINS.some((c) => c.key === input.chainKey)) return { ok: false, error: "Pick Base or Arbitrum for your loan." };
  const address = parseEvmAddress(input.loanAddress);
  if (!address.ok) return address;
  const limits = buildCreateLimits(input.fields);
  if (!limits.ok) return limits;
  const fields = { owner, chainKey: input.chainKey, borrower: address.value, limits: limits.value, salt: input.salt };
  return { ok: true, value: { vaultId: await vaultNameFor(fields), ...fields } };
}

/** The trigger, max per rescue and daily cap as the contract's `Limits` JSON, with the hidden defaults for the rest. */
export function buildCreateLimits(fields: CreateFields): Parsed<LimitsJson> {
  const input: LimitsInput = { ...fields, targetHf: HIDDEN_LIMITS.targetHf, cooldownSecs: HIDDEN_LIMITS.cooldownSecs, maxFeeGwei: HIDDEN_LIMITS.maxFeeGwei, maxGasLimit: HIDDEN_LIMITS.maxGasLimit };
  return parseLimits(input);
}

export type CreateInputs = {
  /** The connected NEAR account that would own the vault (named in the invite message). */
  owner: string;
  /** The deploy key, code hash, code size and bot are configured on this site. */
  creationOpen: boolean;
  /** yoctoNEAR the create call attaches; null when creation is not configured. */
  deposit: bigint | null;
  /** The connected account's NEAR balance; null until read. */
  nearBalance: bigint | null;
  loanAddress: string;
  /** null = not read yet. */
  debtKind: DebtKind | null;
  chainName: string;
  fields: CreateFields;
  /** Vaults this account already has or is creating. */
  vaultCount: number;
  /** The server's answer to "may this owner create?"; "error" = the check failed; undefined = not answered yet. */
  invite: InviteStatus | "error" | undefined;
};

/** Why "Create my Rescue vault" is disabled, in one calm sentence, or null when it can proceed. First match wins. */
export function createBlockReason(i: CreateInputs): string | null {
  if (!i.creationOpen || i.deposit === null) return "Vault creation opens soon.";
  const invite = inviteBlockReason(i.owner, i.invite);
  if (invite) return invite;
  if (i.vaultCount >= MAX_VAULTS) return `You've reached the limit of ${MAX_VAULTS} vaults. Close one to open another.`;
  const address = parseEvmAddress(i.loanAddress);
  if (!address.ok) return i.loanAddress.trim() === "" ? "Enter the address that holds your Aave loan." : address.error;
  if (i.debtKind === null) return `Looking for your loan on ${i.chainName}...`;
  const debt = debtBlockReason(i.debtKind, i.chainName);
  if (debt) return debt;
  const limits = buildCreateLimits(i.fields);
  if (!limits.ok) return limits.error;
  if (i.nearBalance !== null && i.nearBalance < i.deposit + GAS_ALLOWANCE_YOCTO) {
    return `Opening a vault holds about ${nearText(i.deposit, 2)}; you have ${nearText(i.nearBalance, 2)}. You get it back when you close the vault.`;
  }
  return null;
}
