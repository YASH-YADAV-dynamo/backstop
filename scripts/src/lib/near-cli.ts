/**
 * Builds near-cli-rs commands the owner runs in their own CLI / wallet. Our scripts never sign as
 * the owner (v2 hard rule: users never share keys). Pure: no network, no env.
 */
import { NEAR } from "@backstop/config";

/** Single-quotes a value for POSIX shells. */
export const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export interface OwnerCall {
  contractId: string;
  /** Who signs: the policy owner (from get_config). */
  signer: string;
  method: string;
  args: Record<string, unknown>;
  tgas: number;
  /** yoctoNEAR; owner methods except pause / activate take exactly 1. */
  depositYocto: bigint;
}

export function nearCliCall(c: OwnerCall): string {
  const deposit = c.depositYocto === 0n ? "0 NEAR" : `${c.depositYocto} yoctoNEAR`;
  return [
    `near contract call-function as-transaction ${c.contractId} ${c.method} \\`,
    `    json-args ${shellQuote(JSON.stringify(c.args))} \\`,
    `    prepaid-gas ${shellQuote(`${c.tgas} TGas`)} attached-deposit ${shellQuote(deposit)} \\`,
    `    sign-as ${c.signer} network-config ${NEAR.networkId} sign-with-keychain send`,
  ].join("\n");
}

/** Function-call key for the agent: only the three agent methods on this policy. */
export function nearCliAgentKey(agent: string, policyId: string, methods: readonly string[], publicKey: string, allowanceNear = "1 NEAR"): string {
  return [
    `near account add-key ${agent} \\`,
    "    grant-function-call-access \\",
    `        --allowance ${shellQuote(allowanceNear)} \\`,
    `        --contract-account-id ${policyId} \\`,
    `        --function-names ${shellQuote(methods.join(", "))} \\`,
    `    use-manually-provided-public-key ${publicKey} \\`,
    `    network-config ${NEAR.networkId} \\`,
    "    sign-with-keychain \\",
    "    send",
  ].join("\n");
}
