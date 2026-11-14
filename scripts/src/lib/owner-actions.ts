/** Owner actions of the policy as pure data (method, args, gas, deposit). No network, no env. */
import { getAddress, isAddress } from "viem";
import { POLICY, isNearAccountId } from "@backstop/config";
import { LIMIT_FLAGS_HELP, decimalToUnits, hasLimitFlags, limitsFromFlags, limitsFromView, type LimitFlags } from "./limits.js";
import type { OwnerCall } from "./near-cli.js";

const ACTIONS =
  "pause | unpause | activate | set-agent <agent.near> | set-borrower <0x..> | set-bridge-signer <ed25519:..> | " +
  `withdraw --usdc <N> | withdraw-near --near <N> | set-limits [${LIMIT_FLAGS_HELP}]`;
export const USAGE = `Usage: policy status | policy print <${ACTIONS}>`;

export interface PrintInput {
  action: string | undefined;
  arg: string | undefined;
  usdc?: string | undefined;
  near?: string | undefined;
  limitFlags: LimitFlags;
}

const ONE_YOCTO = 1n;

/** Method, args, gas and deposit for one owner action. `currentLimits` is needed for set-limits. */
export function ownerAction(p: PrintInput, currentLimits?: unknown): Omit<OwnerCall, "contractId" | "signer"> {
  const owner = POLICY.gas.owner;
  const need = (what: string) => {
    if (p.arg === undefined) throw new Error(`print ${p.action} needs ${what}. ${USAGE}`);
    return p.arg;
  };
  switch (p.action) {
    case "pause":
      return { method: "pause", args: {}, tgas: owner, depositYocto: 0n };
    case "unpause":
      return { method: "unpause", args: {}, tgas: owner, depositYocto: ONE_YOCTO };
    case "activate":
      return { method: "activate", args: {}, tgas: POLICY.gas.activate, depositYocto: 0n };
    case "set-agent": {
      const agent = need("<agent.near>");
      if (!isNearAccountId(agent)) throw new Error(`set-agent needs a NEAR account id like agent.near, got "${agent}".`);
      return { method: "set_agent", args: { agent }, tgas: owner, depositYocto: ONE_YOCTO };
    }
    case "set-borrower": {
      const b = need("<0x address on the loan chain>");
      if (!isAddress(b)) throw new Error(`set-borrower needs a 0x EVM address, got "${b}".`);
      return { method: "set_on_behalf_of", args: { on_behalf_of: getAddress(b) }, tgas: owner, depositYocto: ONE_YOCTO };
    }
    case "set-bridge-signer": {
      const pk = need("<ed25519:...>");
      if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(pk)) throw new Error(`set-bridge-signer needs an ed25519:<base58> public key, got "${pk}".`);
      return { method: "set_bridge_signer", args: { public_key: pk }, tgas: owner, depositYocto: ONE_YOCTO };
    }
    case "withdraw": {
      if (p.usdc === undefined) throw new Error(`print withdraw needs --usdc <amount>. ${USAGE}`);
      const amount = decimalToUnits("usdc", p.usdc, 6);
      if (amount === 0n) throw new Error("--usdc must be > 0.");
      return { method: "withdraw", args: { amount: amount.toString() }, tgas: POLICY.gas.withdraw, depositYocto: ONE_YOCTO };
    }
    case "withdraw-near": {
      if (p.near === undefined) throw new Error(`print withdraw-near needs --near <amount>. ${USAGE}`);
      const amount = decimalToUnits("near", p.near, 24);
      if (amount === 0n) throw new Error("--near must be > 0.");
      return { method: "withdraw_near", args: { amount: amount.toString() }, tgas: owner, depositYocto: ONE_YOCTO };
    }
    case "set-limits": {
      if (!hasLimitFlags(p.limitFlags)) throw new Error(`print set-limits needs at least one limit flag. ${USAGE}`);
      const next = limitsFromFlags(p.limitFlags, limitsFromView(currentLimits));
      return { method: "set_limits", args: { limits: next }, tgas: owner, depositYocto: ONE_YOCTO };
    }
    default:
      throw new Error(USAGE);
  }
}

