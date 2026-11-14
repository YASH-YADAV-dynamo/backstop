/**
 * Read-only admin view of a policy, plus the near-cli-rs commands its OWNER runs in their own
 * wallet / CLI. Nothing here signs: Backstop never holds the owner's key.
 *   pnpm --filter @backstop/scripts policy status
 *   pnpm --filter @backstop/scripts policy print <action> [args]
 * Actions: pause | unpause | activate | set-agent <agent.near> | set-borrower <0x..> |
 *   set-bridge-signer <ed25519:..> | withdraw --usdc <N> | withdraw-near --near <N> |
 *   set-limits [limit flags] (starts from the on-chain limits; flags you leave out keep their value)
 */
import { parseArgs } from "node:util";
import { formatUnits } from "viem";
import type { Provider } from "near-api-js";
import { NEAR, loadEnv, requireEnv } from "@backstop/config";
import { ftBalance, viewAccessKeys, viewCall } from "@backstop/chains";
import { nearProviderFor, runMain } from "./lib/context.js";
import { formatNear } from "./lib/deploy-plan.js";
import { json } from "./lib/format.js";
import { LIMIT_OPTIONS, describeLimits, hasLimitFlags, limitsFromView } from "./lib/limits.js";
import { nearCliCall } from "./lib/near-cli.js";
import { USAGE, ownerAction, type PrintInput } from "./lib/owner-actions.js";

const usdcOf = (v: unknown) => (typeof v === "string" && /^\d+$/.test(v) ? `${formatUnits(BigInt(v), 6)} USDC` : String(v));
const timeOf = (v: unknown) => {
  if (!(typeof v === "string" || typeof v === "number") || !/^\d+$/.test(String(v))) return String(v);
  const secs = Number(v);
  return secs === 0 ? "never" : `${new Date(secs * 1000).toISOString()} (${secs})`;
};

async function status(provider: Provider, contractId: string): Promise<void> {
  const [config, limitsRaw, s, keys, account, usdc] = await Promise.all([
    viewCall<Record<string, unknown>>(provider, contractId, "get_config"),
    viewCall<Record<string, unknown>>(provider, contractId, "get_limits"),
    viewCall<Record<string, unknown>>(provider, contractId, "get_status"),
    viewAccessKeys(provider, contractId),
    provider.viewAccount({ accountId: contractId }),
    ftBalance(provider, NEAR.usdcToken, contractId),
  ]);
  console.log(`Policy contract ${contractId}`);
  console.log(`  access keys:   ${keys.length === 0 ? "none (keyless)" : `${keys.length} -- DANGER: a key can bypass every limit`}`);
  console.log(`  code_hash:     ${account.code_hash}`);
  console.log(`  NEAR balance:  ${formatNear(BigInt(account.amount))}`);
  console.log(`  USDC on NEAR:  ${usdcOf(usdc.toString())}`);
  console.log("\nget_config:");
  console.log(json(config));
  const paused = limitsRaw.paused;
  console.log(`\nget_limits: ${paused === true ? "PAUSED" : paused === false ? "active" : `paused=${String(paused)}`}`);
  for (const line of describeLimits(limitsFromView(limitsRaw))) console.log(`  ${line}`);
  console.log("\nget_status:");
  console.log(`  spent today:             ${usdcOf(s.spent_today)}`);
  console.log(`  remaining today:         ${usdcOf(s.remaining_today)}`);
  console.log(`  day start (UTC):         ${timeOf(s.day_start)}`);
  console.log(`  last rescue at:          ${timeOf(s.last_rescue_at)}`);
  console.log(`  cooldown ends at:        ${timeOf(s.cooldown_ends_at)}`);
  console.log(`  rescue count:            ${String(s.rescue_count)}`);
  console.log(`  bridged today:           ${usdcOf(s.bridge_spent_today)}`);
  console.log(`  bridge remaining today:  ${usdcOf(s.bridge_remaining_today)}`);
  console.log(`  last bridge at:          ${timeOf(s.last_bridge_at)}`);
  console.log(`  bridge cooldown ends at: ${timeOf(s.bridge_cooldown_ends_at)}`);
  console.log(`  bridge count:            ${String(s.bridge_count)}`);
  console.log(`  last approve_pool at:    ${timeOf(s.last_approve_at)}`);
  console.log(`  last bridge:             ${s.last_bridge === null ? "none" : JSON.stringify(s.last_bridge)}`);
}

async function print(provider: Provider, contractId: string, p: PrintInput): Promise<void> {
  const [config, limitsRaw] = await Promise.all([
    viewCall<Record<string, unknown>>(provider, contractId, "get_config"),
    viewCall<Record<string, unknown>>(provider, contractId, "get_limits"),
  ]);
  if (typeof config.owner !== "string") throw new Error(`get_config of ${contractId} has no owner. Check that it runs contracts/policy v2.`);
  const call = ownerAction(p, limitsRaw);
  if (call.method === "set_limits") {
    const before = describeLimits(limitsFromView(limitsRaw));
    const after = describeLimits(call.args.limits as ReturnType<typeof limitsFromView>);
    console.log("New limits (* = changed):");
    after.forEach((line, i) => console.log(`  ${line === before[i] ? " " : "*"} ${line}`));
  }
  const signer = call.method === "activate" ? "<any.near>" : config.owner;
  console.log(`\nRun this in your own near-cli-rs (signs as ${signer}; Backstop never sees the key):\n`);
  console.log(nearCliCall({ contractId, signer, ...call }));
}

runMain(async () => {
  const { values, positionals } = parseArgs({
    options: { ...LIMIT_OPTIONS, usdc: { type: "string" }, near: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  const [command, action, arg, ...rest] = positionals;
  const { usdc, near, ...limitFlags } = values;
  if (rest.length) throw new Error(`Unexpected arguments: ${rest.join(" ")}. ${USAGE}`);

  const env = loadEnv();
  const { POLICY_CONTRACT_ID } = requireEnv(env, ["POLICY_CONTRACT_ID"], `policy ${command ?? ""}`.trim());
  const provider = nearProviderFor(env);
  switch (command) {
    case "status":
      if (action !== undefined || usdc !== undefined || near !== undefined || hasLimitFlags(limitFlags)) {
        throw new Error(`status takes no arguments. ${USAGE}`);
      }
      return status(provider, POLICY_CONTRACT_ID);
    case "print":
      if (action !== "set-limits" && hasLimitFlags(limitFlags)) throw new Error(`Limit flags only apply to set-limits. ${USAGE}`);
      return print(provider, POLICY_CONTRACT_ID, { action, arg, usdc, near, limitFlags });
    default:
      throw new Error(
        `${USAGE}\npause/unpause/set-agent/set-limits no longer sign here: use \`policy print <action>\` and run the printed command yourself.`,
      );
  }
});
