/**
 * Backstop agent CLI.
 *   pnpm demo                       one pass: read HF, rescue if below the contract's trigger
 *   pnpm demo --dry-run             same, but sends nothing and needs no private keys
 *   pnpm demo --trigger 3.0         demo override: treat HF < 3.0 as unsafe (still capped by the contract)
 *   pnpm demo --watch [--interval 30]   keep watching (pnpm --filter @backstop/agent start)
 *   pnpm demo --allow-keyed-rehearsal   accept a rehearsal policy that still has its ONE temporary key
 *                                       (deploy-policy --rehearsal; finalize it before real use)
 *   pnpm demo --service [--dry-run]     bot service: every vault from FACTORY_CONTRACT_ID + POLICY_CONTRACT_IDS
 *                                       (pnpm --filter @backstop/agent start); see service.ts
 */
import { parseArgs } from "node:util";
import { NEAR, chainAddressUrl, loadEnv, loanChainById, requireEnv, rpcList } from "@backstop/config";
import { assertChainId, evmClient, nearProvider, viewAccessKeys } from "@backstop/chains";
import { acquireInstanceLock, openStore, openVaultStatusStore } from "@backstop/db";
import { deriveAddressOnChain, deriveEvmAddress } from "@backstop/signer";
import { assertConfigMatches } from "./checks.js";
import { liveDeps } from "./deps.js";
import { readPolicy } from "./policy.js";
import { resumeSignedRepay, runOnce, type RunOptions } from "./rescue.js";
import { VaultService } from "./service.js";
import { liveServiceIO } from "./service-live.js";

const USAGE =
  "Usage: pnpm demo [--dry-run] [--trigger <HF, e.g. 3.0>] [--watch] [--interval <secs, default 30>] [--allow-keyed-rehearsal] [--service]";

function parseTrigger(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const hf = Number(v);
  if (!/^\d+(\.\d+)?$/.test(v) || !(hf > 1) || hf > 100) throw new Error(`--trigger must be a health factor above 1, e.g. 3.0. ${USAGE}`);
  return Math.round(hf * 10_000);
}

const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const log = (line: string) => console.log(`[${stamp()}] ${line}`);

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      trigger: { type: "string" },
      watch: { type: "boolean", default: false },
      interval: { type: "string", default: "30" },
      "allow-keyed-rehearsal": { type: "boolean", default: false },
      service: { type: "boolean", default: false },
    },
    strict: true,
  });
  const intervalSecs = Number(values.interval);
  if (!Number.isInteger(intervalSecs) || intervalSecs < 5) throw new Error(`--interval must be a whole number of seconds >= 5. ${USAGE}`);
  const triggerOverrideBps = parseTrigger(values.trigger);
  const opts: RunOptions = { dryRun: values["dry-run"], ...(triggerOverrideBps !== undefined && { triggerOverrideBps }) };

  const env = loadEnv();
  if (values.service) {
    if (values["allow-keyed-rehearsal"]) throw new Error("--allow-keyed-rehearsal is not accepted in --service mode: the service refuses every keyed vault.");
    return service(env, opts, intervalSecs);
  }
  const { POLICY_CONTRACT_ID } = requireEnv(env, ["POLICY_CONTRACT_ID"], "The agent");
  if (!opts.dryRun) requireEnv(env, ["AGENT_ACCOUNT_ID", "AGENT_PRIVATE_KEY"], "A live run (use --dry-run to try without keys)");

  // D29: the policy says which chain its loan lives on. Read it first, then build the matching client.
  // D.3: the contract is the source of truth for the loan-chain address; check it two independent ways,
  // and refuse a policy account that still has keys.
  const provider = nearProvider(rpcList(env.NEAR_RPC_URL, NEAR.rpcUrls));
  const [{ config: read }, keys] = await Promise.all([readPolicy(provider, POLICY_CONTRACT_ID), viewAccessKeys(provider, POLICY_CONTRACT_ID)]);
  const chain = loanChainById(read.chainId);
  const client = evmClient(chain, rpcList(env[chain.rpcEnvVar], chain.rpcUrls));
  await assertChainId(client, chain);
  const [{ address: chainsigAddress }, { address: mpcViewAddress }] = await Promise.all([
    deriveEvmAddress(chain, POLICY_CONTRACT_ID, NEAR.derivationPath),
    deriveAddressOnChain(provider, POLICY_CONTRACT_ID, NEAR.derivationPath),
  ]);
  const config = assertConfigMatches(read, {
    chainsigAddress,
    mpcViewAddress,
    accessKeyCount: keys.length,
    allowKeyedRehearsal: values["allow-keyed-rehearsal"],
    ...(!opts.dryRun && env.AGENT_ACCOUNT_ID !== undefined && { agentAccountId: env.AGENT_ACCOUNT_ID }),
  });

  log(`Backstop agent${opts.dryRun ? " (DRY RUN: nothing is sent)" : ""}`);
  if (keys.length > 0) {
    log(`WARNING: REHEARSAL policy with access key ${keys[0]!.publicKey}: whoever holds it bypasses every limit. Finalize it before real use.`);
  }
  log(`Policy ${POLICY_CONTRACT_ID}: derived ${chain.name} address ${config.baseAddress} (${chainAddressUrl(chain, config.baseAddress)})`);
  log(`Borrower ${config.onBehalfOf} (${chainAddressUrl(chain, config.onBehalfOf)})`);
  log(`Service fee: ${config.feeBps} bps (${(config.feeBps / 100).toFixed(2)}%) of each bridged amount, paid to ${config.feeAccount}`);
  if (triggerOverrideBps !== undefined) log(`Trigger override: HF ${(triggerOverrideBps / 10_000).toFixed(2)}`);

  const store = await openStore(env);
  try {
    const deps = liveDeps(env, client, chain, store, log);
    if (!opts.dryRun) await resumeSignedRepay(deps, config);
    if (!values.watch) {
      const result = await runOnce(deps, opts);
      if (result.record?.status === "failed") process.exitCode = 1;
      return;
    }
    let stopping = false;
    process.once("SIGINT", () => {
      stopping = true;
      log("Stopping after this pass (Ctrl+C again to force).");
    });
    while (!stopping) {
      try {
        if (!opts.dryRun) await resumeSignedRepay(deps, config);
        await runOnce(deps, opts);
      } catch (err) {
        // A read failing (RPC hiccup) must not kill the watcher: log and try again next tick.
        log(`Pass failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!stopping) await new Promise((r) => setTimeout(r, intervalSecs * 1000));
    }
  } finally {
    await store.close();
  }
}

async function service(env: ReturnType<typeof loadEnv>, opts: RunOptions, intervalSecs: number): Promise<void> {
  const e = requireEnv(env, ["AGENT_ACCOUNT_ID"], "The bot service (the bot account every vault names as agent)");
  if (!opts.dryRun) requireEnv(env, ["AGENT_PRIVATE_KEY"], "A live service run (use --dry-run to try without keys)");
  if (!env.FACTORY_CONTRACT_ID && !env.POLICY_CONTRACT_IDS?.length && !env.POLICY_CONTRACT_ID) {
    throw new Error("The bot service needs FACTORY_CONTRACT_ID and/or POLICY_CONTRACT_IDS in .env (the vaults to watch).");
  }
  const lock = await acquireInstanceLock(env);
  if (!lock) {
    console.error("Another Backstop bot instance is already running (instance lock held). Exiting.");
    process.exitCode = 3;
    return;
  }
  if (!env.DATABASE_URL) {
    log("WARNING: DATABASE_URL is not set: rescues and vault status go to local JSON files, which a web app on another host cannot read.");
  }
  const [store, statusStore] = await Promise.all([openStore(env), openVaultStatusStore(env)]);
  try {
    const { io, factoryDefaultAgent } = await liveServiceIO(e, store, statusStore, log, opts);
    log(`Backstop bot service${opts.dryRun ? " (DRY RUN: nothing is sent)" : ""} as ${e.AGENT_ACCOUNT_ID}; pass every ${intervalSecs}s.`);
    if (env.FACTORY_CONTRACT_ID) log(`Factory ${env.FACTORY_CONTRACT_ID} (default agent ${factoryDefaultAgent}).`);
    if (factoryDefaultAgent !== null && factoryDefaultAgent !== e.AGENT_ACCOUNT_ID) {
      log(`WARNING: the factory's default_agent is ${factoryDefaultAgent}, not ${e.AGENT_ACCOUNT_ID}: new vaults will be refused (AGENT_MISMATCH).`);
    }
    const svc = new VaultService(io, { dryRun: opts.dryRun, intervalMs: intervalSecs * 1000 });
    let stopping = false;
    process.once("SIGINT", () => {
      stopping = true;
      log("Stopping after this pass and the running rescues (Ctrl+C again to force).");
    });
    process.once("SIGTERM", () => {
      stopping = true;
    });
    await svc.run(() => stopping);
  } finally {
    await Promise.all([store.close(), statusStore.close()]);
    await lock.release();
  }
}

main().catch((err: unknown) => {
  console.error(`\nERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
