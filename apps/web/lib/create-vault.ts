/** Pure rules of the "Create my Rescue vault" card (K.6, v3 section 2): defaults, limits, and when creating is blocked. */
import { formatUnits } from "viem";
import { parseEvmAddress, parseLimits, type LimitsInput, type LimitsJson, type Parsed } from "@/lib/validate";
import { debtBlockReason, type DebtKind } from "@/lib/debt";

/** The three fields people see. */
export type CreateFields = { triggerHf: string; maxPerRescue: string; dailyCap: string };

/** K.6 defaults for the three visible limits. */
export const DEFAULT_FIELDS: CreateFields = { triggerHf: "1.10", maxPerRescue: "5", dailyCap: "10" };

/** Hidden limits: the same values as `DEFAULT_LIMITS` in scripts/src/lib/limits.ts (a test pins them). */
export const HIDDEN_LIMITS = { targetHf: "1.30", cooldownSecs: "600", maxFeeGwei: "1", maxGasLimit: "400000" } as const;

/** NEAR the factory keeps for the vault's name index and token registration; never returned (K.1). */
export const NOT_RETURNED_YOCTO = 6_250_000_000_000_000_000_000n;
/** Spare NEAR the owner's account needs on top of the deposit, for the wallet's own gas. */
export const GAS_ALLOWANCE_YOCTO = 50_000_000_000_000_000_000_000n;
/** Mirrors `MAX_VAULTS_PER_OWNER` in the factory. */
export const MAX_VAULTS = 8;

export const nearText = (yocto: bigint, digits = 3): string => `${Number(formatUnits(yocto, 24)).toLocaleString("en-US", { maximumFractionDigits: digits })} NEAR`;

/** What the owner gets back on close: the deposit minus what the factory keeps. */
export const returnedOnClose = (minDeposit: bigint): bigint => (minDeposit > NOT_RETURNED_YOCTO ? minDeposit - NOT_RETURNED_YOCTO : 0n);

/** The trigger, max per rescue and daily cap as the contract's `Limits` JSON, with the hidden defaults for the rest. */
export function buildCreateLimits(fields: CreateFields): Parsed<LimitsJson> {
  const input: LimitsInput = { ...fields, targetHf: HIDDEN_LIMITS.targetHf, cooldownSecs: HIDDEN_LIMITS.cooldownSecs, maxFeeGwei: HIDDEN_LIMITS.maxFeeGwei, maxGasLimit: HIDDEN_LIMITS.maxGasLimit };
  return parseLimits(input);
}

export type CreateInputs = {
  /** The factory was read and passed its checks. */
  factoryReady: boolean;
  /** yoctoNEAR the create call attaches; null until read. */
  minDeposit: bigint | null;
  /** The connected account's NEAR balance; null until read. */
  nearBalance: bigint | null;
  loanAddress: string;
  /** null = not read yet. */
  debtKind: DebtKind | null;
  chainName: string;
  fields: CreateFields;
  /** Vaults this account already has (the factory allows 8). */
  vaultCount: number;
};

/** Why "Create my Rescue vault" is disabled, in one calm sentence, or null when it can proceed. First match wins. */
export function createBlockReason(i: CreateInputs): string | null {
  if (!i.factoryReady || i.minDeposit === null) return "Checking that vault creation is safe...";
  if (i.vaultCount >= MAX_VAULTS) return `You've reached the limit of ${MAX_VAULTS} vaults. Close one to open another.`;
  const address = parseEvmAddress(i.loanAddress);
  if (!address.ok) return i.loanAddress.trim() === "" ? "Enter the address that holds your Aave loan." : address.error;
  if (i.debtKind === null) return `Looking for your loan on ${i.chainName}...`;
  const debt = debtBlockReason(i.debtKind, i.chainName);
  if (debt) return debt;
  const limits = buildCreateLimits(i.fields);
  if (!limits.ok) return limits.error;
  if (i.nearBalance !== null && i.nearBalance < i.minDeposit + GAS_ALLOWANCE_YOCTO) {
    return `Opening a vault holds about ${nearText(i.minDeposit, 2)}; you have ${nearText(i.nearBalance, 2)}. You get it back when you close the vault.`;
  }
  return null;
}
