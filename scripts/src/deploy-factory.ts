/**
 * Deploys the keyless Backstop vault factory (design D32, section K) once, on MAINNET.
 *   pnpm --filter @backstop/scripts deploy-factory [--name vaults] [--agent <agent.near>] [--wasm <path>] [--rehearsal] [--send]
 * Default is a dry run: prints the factory id, both wasm sizes and hashes, the config built from
 * LOAN_CHAINS, the exact NEAR the deployer needs and the per-vault `min_deposit`.
 * --send: ONE transaction to `<name>.<deployer>`: CreateAccount, Transfer, DeployContract,
 * FunctionCall new({ config }). No AddKey, so the factory and the policy code it embeds are fixed for good.
 * Signer: DEPLOYER_ACCOUNT_ID / DEPLOYER_PRIVATE_KEY. Config: AGENT_ACCOUNT_ID (or --agent),
 * FEE_ACCOUNT_ID / FEE_BPS (no FEE_ACCOUNT_ID = no fee: the deployer stands in at 0 bps).
 * Rehearsal (D24): --rehearsal adds the deployer key as a temporary full-access key (the web refuses
 * a keyed factory). Test one create_policy, then
 *   deploy-factory --finalize <factory> --send                  (deletes the key; checks the key list is empty)
 *   deploy-factory --abort <factory> --confirm-empty --send     (deletes a keyed factory that created no vault)
 * Build the wasm first: `pnpm factory:build`.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { baseEncode, type Provider } from "near-api-js";
import { LOAN_CHAINS, loadEnv, nearAccountUrl, nearTxUrl, repoRoot, requireEnv } from "@backstop/config";
import { nearAccount, sendTransaction, viewAccessKeys, viewCall } from "@backstop/chains";
import { nearProviderFor, nearUrlsFor, runMain } from "./lib/context.js";
import { abortActions, finalizeActions, formatNear } from "./lib/deploy-plan.js";
import {
  FACTORY_NEW_TGAS,
  embeds,
  factoryAccountId,
  factoryBudget,
  factoryConfig,
  factoryDeployActions,
  factoryEnvLines,
  type FactoryConfigJson,
} from "./lib/factory-plan.js";
import { json } from "./lib/format.js";
import { assertFullAccessKey, publicKeyOf } from "./lib/keys.js";

const USAGE =
  "Usage: deploy-factory [--name vaults] [--agent <agent.near>] [--wasm <factory.wasm>] [--policy-wasm <policy.wasm>] [--rehearsal] [--send]\n" +
  "       deploy-factory --finalize <factory.near> [--send]\n" +
  "       deploy-factory --abort <factory.near> --confirm-empty [--send]   (keyed rehearsal, no vault created: delete it, NEAR returns to the deployer)";

const FACTORY_WASM = join(repoRoot, "contracts/factory/target/near/backstop_factory.wasm");
const POLICY_WASM = join(repoRoot, "contracts/policy/target/near/backstop_policy.wasm");
/** Mainnet storage price; used only when the dry run cannot reach an RPC. */
const MAINNET_YOCTO_PER_BYTE = 10n ** 19n;

function readWasm(arg: string | undefined, fallback: string, what: string) {
  const path = resolve(arg ?? fallback);
  if (!existsSync(path)) throw new Error(`${what} wasm ${path} does not exist. Build it with \`pnpm factory:build\` (or pass the right path).`);
  const code = readFileSync(path);
  const digest = createHash("sha256").update(code).digest();
  return { path, code, hex: digest.toString("hex"), codeHash: baseEncode(digest) };
}

async function storagePerByte(provider: Provider, send: boolean): Promise<bigint> {
  try {
    const cfg = await provider.experimental_protocolConfig({ finality: "final" });
    const perByte = cfg.runtime_config?.storage_amount_per_byte;
    if (perByte !== undefined && /^\d+$/.test(perByte)) return BigInt(perByte);
    throw new Error("no runtime_config.storage_amount_per_byte");
  } catch (err) {
    if (send) throw new Error(`Cannot read the storage price from NEAR RPC (${err instanceof Error ? err.message : String(err)}). Try another NEAR_RPC_URL.`);
    console.warn(`WARN: NEAR RPC unreachable; using the mainnet storage price ${MAINNET_YOCTO_PER_BYTE} yocto/byte.`);
    return MAINNET_YOCTO_PER_BYTE;
  }
}

async function accountExists(provider: Provider, accountId: string): Promise<boolean | undefined> {
  try {
    await provider.viewAccount({ accountId });
    return true;
  } catch (err) {
    const msg = JSON.stringify(err instanceof Error ? { m: err.message, ...err } : err);
    if (/does not exist|UNKNOWN_ACCOUNT/i.test(msg)) return false;
    return undefined;
  }
}

/** --finalize / --abort on a keyed (rehearsal) factory: both sign AS THE FACTORY with the deployer key. */
async function rehearsalFollowUp(mode: "finalize" | "abort", factoryId: string, send: boolean, confirmEmpty: boolean) {
  const env = loadEnv();
  const provider = nearProviderFor(env);
  const keys = await viewAccessKeys(provider, factoryId);
  console.log(`Factory ${factoryId} has ${keys.length} access key(s): ${keys.map((k) => k.publicKey).join(", ") || "none"}`);
  if (keys.length === 0) throw new Error(`${factoryId} is already keyless: nothing can ${mode} it any more (that is the point of --finalize).`);
  if (mode === "abort") {
    const count = await viewCall<string>(provider, factoryId, "policy_count");
    if (count !== "0") {
      throw new Error(`${factoryId} already created ${count} vault(s); their owners find them through its index. Finalize it instead of deleting it.`);
    }
    if (!confirmEmpty) {
      throw new Error(`Refusing to abort ${factoryId} without --confirm-empty (check that no create_policy is in flight and no refund is pending).`);
    }
  }
  console.log(
    mode === "abort"
      ? `Transaction (signer ${factoryId}, receiver ${factoryId}): DeleteAccount, beneficiary ${env.DEPLOYER_ACCOUNT_ID ?? "<DEPLOYER_ACCOUNT_ID>"}`
      : `Transaction (signer ${factoryId}, receiver ${factoryId}): DeleteKey <deployer public key>`,
  );
  if (!send) {
    console.log("\nDry run: nothing was signed or sent. Re-run with --send to broadcast on MAINNET.");
    return;
  }
  const { DEPLOYER_PRIVATE_KEY, DEPLOYER_ACCOUNT_ID } = requireEnv(env, ["DEPLOYER_PRIVATE_KEY", "DEPLOYER_ACCOUNT_ID"], `deploy-factory --${mode} --send`);
  const rehearsalKey = publicKeyOf(DEPLOYER_PRIVATE_KEY);
  await assertFullAccessKey(provider, factoryId, DEPLOYER_PRIVATE_KEY, "DEPLOYER_PRIVATE_KEY");
  if (keys.length !== 1) throw new Error(`${factoryId} has ${keys.length} keys, expected only the rehearsal key ${rehearsalKey}. Remove the others by hand first.`);
  const signer = nearAccount(factoryId, DEPLOYER_PRIVATE_KEY, nearUrlsFor(env));
  const sent = await sendTransaction(signer, factoryId, mode === "abort" ? abortActions(DEPLOYER_ACCOUNT_ID) : finalizeActions(rehearsalKey));
  console.log(`Sent: ${nearTxUrl(sent.txHash)}`);
  if (mode === "abort") {
    console.log(`${factoryId} is deleted and its NEAR went back to ${DEPLOYER_ACCOUNT_ID}.`);
    return;
  }
  const after = await viewAccessKeys(provider, factoryId);
  if (after.length > 0) throw new Error(`DANGER: ${factoryId} still has ${after.length} key(s). Do not publish it; re-run --finalize.`);
  console.log(`Key list of ${factoryId}: empty. The factory is now keyless and immutable; the web accepts it.`);
}

runMain(async () => {
  const { values, positionals } = parseArgs({
    options: {
      name: { type: "string", default: "vaults" },
      agent: { type: "string" },
      wasm: { type: "string" },
      "policy-wasm": { type: "string" },
      rehearsal: { type: "boolean", default: false },
      finalize: { type: "string" },
      abort: { type: "string" },
      "confirm-empty": { type: "boolean", default: false },
      send: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length) throw new Error(`Unexpected arguments: ${positionals.join(" ")}. ${USAGE}`);
  if (values.finalize !== undefined && values.abort !== undefined) throw new Error(`Pass --finalize or --abort, not both. ${USAGE}`);
  if (values.abort !== undefined) return rehearsalFollowUp("abort", values.abort, values.send, values["confirm-empty"]);
  if (values.finalize !== undefined) return rehearsalFollowUp("finalize", values.finalize, values.send, false);

  const env = loadEnv();
  const { DEPLOYER_ACCOUNT_ID } = requireEnv(env, ["DEPLOYER_ACCOUNT_ID"], "Deploying the factory (the operator account pays for it)");
  const agent = values.agent ?? env.AGENT_ACCOUNT_ID;
  if (agent === undefined) throw new Error(`Pass --agent <agent.near> or set AGENT_ACCOUNT_ID in .env. ${USAGE}`);
  const factoryId = factoryAccountId(values.name, DEPLOYER_ACCOUNT_ID, LOAN_CHAINS);
  const feeAccount = env.FEE_ACCOUNT_ID ?? DEPLOYER_ACCOUNT_ID;
  const feeBps = env.FEE_ACCOUNT_ID ? env.FEE_BPS : 0;
  const config: FactoryConfigJson = factoryConfig({ factoryId, chains: LOAN_CHAINS, agent, feeAccount, feeBps });

  const factory = readWasm(values.wasm, FACTORY_WASM, "Factory");
  const policy = readWasm(values["policy-wasm"], POLICY_WASM, "Policy");
  if (!embeds(factory.code, policy.code)) {
    throw new Error(
      `${factory.path} does not embed ${policy.path} byte for byte (stale build?). Rebuild both with \`pnpm factory:build\`.`,
    );
  }

  const provider = nearProviderFor(env);
  const exists = await accountExists(provider, factoryId);
  if (exists === true) throw new Error(`${factoryId} already exists. Pick another --name (or --finalize / --abort a rehearsal factory).`);
  if (exists === undefined && values.send) throw new Error(`Cannot check whether ${factoryId} exists. Try another NEAR_RPC_URL.`);
  const perByte = await storagePerByte(provider, values.send);
  const budget = factoryBudget(factory.code.length, policy.code.length, perByte);
  const rehearsalKey = values.rehearsal && env.DEPLOYER_PRIVATE_KEY ? publicKeyOf(env.DEPLOYER_PRIVATE_KEY) : undefined;

  console.log(`Factory account: ${factoryId} (new, ${values.rehearsal ? "REHEARSAL: temporary full-access key, finalize before publishing" : "keyless"})`);
  console.log(`Vault names:     ${config.chains.map((c) => `${c.key}-<n>.${factoryId}`).join(", ")}`);
  console.log(`Factory wasm:    ${factory.path}`);
  console.log(`  ${factory.code.length} bytes, sha256 ${factory.hex}, NEAR code_hash ${factory.codeHash}`);
  console.log(`Embedded policy: ${policy.path}`);
  console.log(`  ${policy.code.length} bytes, sha256 ${policy.hex}, NEAR code_hash ${policy.codeHash}`);
  console.log(`  (factory.policy_code_hash() will return ${policy.hex}; every vault's code_hash is ${policy.codeHash})`);
  console.log(
    feeBps === 0
      ? "Service fee:     none (set FEE_ACCOUNT_ID in .env to charge one)."
      : `Service fee:     ${feeBps} bps (${(feeBps / 100).toFixed(2)}%) of each bridged amount, paid to ${feeAccount}. Fixed for every vault.`,
  );
  console.log("\nNEAR budget (deployer, once):");
  console.log(`  factory code storage (locked for good, keyless): ${formatNear(budget.codeStake)} (${factory.code.length} bytes x ${perByte} yocto/byte)`);
  console.log(`  state margin:                   ${formatNear(budget.stateMargin)}`);
  console.log(`  spare (refund liquidity, USDC registrations): ${formatNear(budget.spare)}`);
  console.log(`  -> Transfer to the factory:     ${formatNear(budget.transfer)} (${budget.transfer} yocto)`);
  console.log(`  gas reserve:                    ${formatNear(budget.gasReserve)}`);
  console.log(`  NEAR needed on the deployer:    ${formatNear(budget.deployerNeeds)}`);
  console.log(`Per vault (user): min_deposit = ${formatNear(budget.minDeposit)} (${budget.minDeposit} yocto), 300 TGas`);

  console.log(`\nTransaction (signer ${DEPLOYER_ACCOUNT_ID}, receiver ${factoryId}):`);
  const steps = [
    "CreateAccount",
    `Transfer        ${formatNear(budget.transfer)}`,
    ...(values.rehearsal ? [`AddKey          FullAccess ${rehearsalKey ?? "<public key of DEPLOYER_PRIVATE_KEY>"} (temporary, D24)`] : []),
    `DeployContract  ${factory.code.length} bytes, code_hash ${factory.codeHash}`,
    `FunctionCall    new, gas ${FACTORY_NEW_TGAS} TGas, deposit 0, args:\n${json({ config }).replace(/^/gm, "       ")}`,
  ];
  steps.forEach((step, i) => console.log(`  ${i + 1}. ${step}`));
  console.log(values.rehearsal ? "  (rehearsal: run deploy-factory --finalize to delete the key)" : "  (no AddKey: the factory account never has a key)");

  let deployerBalance: bigint | undefined;
  try {
    deployerBalance = BigInt((await provider.viewAccount({ accountId: DEPLOYER_ACCOUNT_ID })).amount);
    console.log(`Deployer ${DEPLOYER_ACCOUNT_ID} holds: ${formatNear(deployerBalance)}`);
  } catch (err) {
    if (values.send) throw new Error(`Cannot read ${DEPLOYER_ACCOUNT_ID} (${err instanceof Error ? err.message : String(err)}). Check DEPLOYER_ACCOUNT_ID / NEAR_RPC_URL.`);
    console.warn(`WARN: could not read ${DEPLOYER_ACCOUNT_ID}'s balance.`);
  }
  if (deployerBalance !== undefined && deployerBalance < budget.deployerNeeds) {
    const msg = `${DEPLOYER_ACCOUNT_ID} holds ${formatNear(deployerBalance)}; it needs ${formatNear(budget.deployerNeeds)} plus its own storage. Top it up, then re-run.`;
    if (values.send) throw new Error(msg);
    console.warn(`\nWARN: ${msg}`);
  }
  if (!values.send) {
    console.log("\nDry run: nothing was signed or sent. Re-run with --send to deploy the factory on MAINNET.");
    return;
  }

  const { DEPLOYER_PRIVATE_KEY } = requireEnv(env, ["DEPLOYER_PRIVATE_KEY"], "deploy-factory --send (signs as the deployer)");
  await assertFullAccessKey(provider, DEPLOYER_ACCOUNT_ID, DEPLOYER_PRIVATE_KEY, "DEPLOYER_PRIVATE_KEY");
  const signer = nearAccount(DEPLOYER_ACCOUNT_ID, DEPLOYER_PRIVATE_KEY, nearUrlsFor(env));
  console.log("\nSending (create + deploy + new)...");
  const sent = await sendTransaction(
    signer,
    factoryId,
    factoryDeployActions(factory.code, config, budget.transfer, values.rehearsal ? publicKeyOf(DEPLOYER_PRIVATE_KEY) : undefined),
  );
  console.log(`Created: ${nearTxUrl(sent.txHash)}`);

  const [keys, account, onChainConfig, codeHashHex, minDep] = await Promise.all([
    viewAccessKeys(provider, factoryId),
    provider.viewAccount({ accountId: factoryId }),
    viewCall<FactoryConfigJson>(provider, factoryId, "get_config"),
    viewCall<string>(provider, factoryId, "policy_code_hash"),
    viewCall<string>(provider, factoryId, "min_deposit"),
  ]);
  const expectedKeys = values.rehearsal ? [publicKeyOf(DEPLOYER_PRIVATE_KEY)] : [];
  const actualKeys = keys.map((k) => k.publicKey);
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((k) => !expectedKeys.includes(k))) {
    throw new Error(`DANGER: ${factoryId} has access key(s) [${actualKeys.join(", ")}], expected [${expectedKeys.join(", ")}]. Do not publish this factory.`);
  }
  console.log(values.rehearsal ? `Key list: only the rehearsal key ${expectedKeys[0]}.` : "Key list: empty (keyless).");
  if (account.code_hash !== factory.codeHash) throw new Error(`code_hash on chain is ${account.code_hash}, expected ${factory.codeHash}. Do not publish this factory.`);
  if (codeHashHex !== policy.hex) throw new Error(`policy_code_hash() is ${codeHashHex}, expected ${policy.hex}. Do not publish this factory.`);
  if (JSON.stringify(onChainConfig) !== JSON.stringify(config)) {
    throw new Error(`get_config() differs from what was sent:\n${json(onChainConfig)}\nDo not publish this factory.`);
  }
  if (BigInt(minDep) !== budget.minDeposit) console.warn(`WARN: min_deposit() is ${minDep}, the script computed ${budget.minDeposit}. The web reads the view, so it stays correct.`);
  console.log(`code_hash ${account.code_hash}, policy_code_hash ${codeHashHex}, min_deposit ${formatNear(BigInt(minDep))}: all match.`);
  console.log(`\nFactory: ${nearAccountUrl(factoryId)}`);
  console.log("Put these in .env (and the web host's environment):");
  for (const line of factoryEnvLines(factoryId, policy.hex)) console.log(`  ${line}`);
  if (values.rehearsal) {
    console.log(
      `REHEARSAL: create one vault with near-cli-rs: near contract call-function as-transaction ${factoryId} create_policy ` +
        `json-args '{"chain":"base","on_behalf_of":"0x...","limits":{...}}' prepaid-gas '300 Tgas' attached-deposit '${minDep} yoctoNEAR' ...; ` +
        `check it, close it, then: deploy-factory --finalize ${factoryId} --send`,
    );
  }
});
