/**
 * Creates a keyless Backstop policy for a user.
 *   pnpm --filter @backstop/scripts deploy-policy --name alice --owner alice.near --borrower 0x... [--chain base|arbitrum] [limit flags]
 * One policy per (user, chain): on Arbitrum the account is `<name>-arb.<deployer>`; Base keeps `<name>.<deployer>`.
 *   ... --send          broadcast on MAINNET (default is a dry run that prints the full transaction)
 * Signer: DEPLOYER_ACCOUNT_ID / DEPLOYER_PRIVATE_KEY (operator account, deploy time only).
 * One transaction to `<name>.<deployer>`: CreateAccount, Transfer, DeployContract, FunctionCall new,
 * FunctionCall activate. No AddKey. Afterwards: assert the key list is empty, print the code hash,
 * then a second transaction registers the policy on NEAR USDC (storage_deposit).
 * Rehearsal (audit F2, design D24): the FIRST mainnet policy should be created with --rehearsal, which
 * adds the deployer's key as a temporary full-access key. Test everything, fix with
 *   deploy-policy --redeploy <policy> [--wasm <path>] --send   (replaces the code, keeps state)
 * then make it keyless for good with
 *   deploy-policy --finalize <policy> --send                   (deletes the key, checks the key list is empty)
 * The agent refuses a keyed policy unless started with --allow-keyed-rehearsal; the web always refuses it.
 * Limit flags (defaults in lib/limits.ts): --trigger 1.1 --target 1.3 --max-per-rescue 5
 *   --daily-cap 10 --cooldown 600 --max-fee-gwei 1 --max-gas 400000. Optional --agent, --wasm <path>.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { baseEncode, teraToGas, type Provider } from "near-api-js";
import { NEAR, POLICY, loadEnv, nearAccountUrl, nearTxUrl, repoRoot, requireEnv } from "@backstop/config";
import { ftBalance, functionCall, nearAccount, sendTransaction, viewAccessKeys, viewCall } from "@backstop/chains";
import { deriveAddressOnChain, deriveEvmAddress } from "@backstop/signer";
import { CHAIN_FLAG_HELP, CHAIN_OPTION, chainFromFlag, nearProviderFor, nearUrlsFor, runMain } from "./lib/context.js";
import {
  abortActions,
  deployActions,
  deployBudget,
  finalizeActions,
  formatNear,
  initArgs,
  policyAccountId,
  redeployActions,
  NEW_TGAS,
} from "./lib/deploy-plan.js";
import { json } from "./lib/format.js";
import { assertFullAccessKey, publicKeyOf } from "./lib/keys.js";
import { DEFAULT_LIMITS, LIMIT_FLAGS_HELP, LIMIT_OPTIONS, describeLimits, limitsFromFlags } from "./lib/limits.js";
import { nearCliAgentKey } from "./lib/near-cli.js";

const USAGE =
  "Usage: deploy-policy --name <label> --owner <user.near> --borrower <0x address on that chain> " +
  `[${CHAIN_FLAG_HELP}] [--agent <agent.near>] [${LIMIT_FLAGS_HELP}] [--wasm <path>] [--rehearsal] [--send]\n` +
  "       deploy-policy --redeploy <policy.near> [--wasm <path>] [--send]\n" +
  "       deploy-policy --finalize <policy.near> [--send]\n" +
  "       deploy-policy --abort <policy.near> --confirm-empty [--send]   (keyed rehearsal only: delete it, NEAR returns to the deployer)";

const WASM_CANDIDATES = [
  join(repoRoot, "contracts/policy/target/near/backstop_policy.wasm"),
  join(repoRoot, "contracts/policy/target/wasm32-unknown-unknown/release/backstop_policy.wasm"),
];

function resolveWasm(arg: string | undefined): string {
  if (arg !== undefined) {
    const p = resolve(arg);
    if (!existsSync(p)) throw new Error(`--wasm ${p} does not exist. Build the contract with \`pnpm contract:build\` or pass the right path.`);
    return p;
  }
  const found = WASM_CANDIDATES.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      `No policy contract wasm found (looked for:\n  ${WASM_CANDIDATES.join("\n  ")}).\n` +
        "Build it with `pnpm contract:build` (or `cargo build --target wasm32-unknown-unknown --release` in contracts/policy), or pass --wasm <path>.",
    );
  }
  return found;
}

async function storagePerByte(provider: Provider): Promise<bigint> {
  const cfg = await provider.experimental_protocolConfig({ finality: "final" });
  const perByte = cfg.runtime_config?.storage_amount_per_byte;
  if (perByte === undefined || !/^\d+$/.test(perByte)) {
    throw new Error("NEAR RPC protocol config has no runtime_config.storage_amount_per_byte. Try another NEAR_RPC_URL.");
  }
  return BigInt(perByte);
}

/** True if the account exists; false only for "does not exist", any other error is thrown. */
async function accountExists(provider: Provider, accountId: string): Promise<boolean> {
  try {
    await provider.viewAccount({ accountId });
    return true;
  } catch (err) {
    const msg = JSON.stringify(err instanceof Error ? { m: err.message, ...err } : err);
    if (/does not exist|UNKNOWN_ACCOUNT/i.test(msg)) return false;
    throw new Error(`Cannot check whether ${accountId} exists (${err instanceof Error ? err.message : String(err)}). Try another NEAR_RPC_URL.`);
  }
}

const wasmInfo = (path: string) => {
  const code = readFileSync(path);
  const digest = createHash("sha256").update(code).digest();
  return { code, digest, codeHash: baseEncode(digest) };
};

/**
 * --redeploy / --finalize on a rehearsal policy. Both sign AS THE POLICY with the deployer's key,
 * which only works while that key is still on the policy (i.e. before --finalize).
 */
async function rehearsalFollowUp(mode: "redeploy" | "finalize" | "abort", policyId: string, wasmArg: string | undefined, send: boolean, confirmEmpty = false) {
  const env = loadEnv();
  const provider = nearProviderFor(env);
  const keys = await viewAccessKeys(provider, policyId);
  console.log(`Policy ${policyId} has ${keys.length} access key(s): ${keys.map((k) => k.publicKey).join(", ") || "none"}`);
  if (keys.length === 0) {
    throw new Error(`${policyId} is already keyless: nothing can ${mode} it any more (that is the point of --finalize).`);
  }
  const wasm = mode === "redeploy" ? wasmInfo(resolveWasm(wasmArg)) : undefined;
  if (wasm) console.log(`Transaction (signer ${policyId}, receiver ${policyId}): DeployContract ${wasm.code.length} bytes, code_hash ${wasm.codeHash}`);
  else if (mode === "abort") console.log(`Transaction (signer ${policyId}, receiver ${policyId}): DeleteAccount, beneficiary ${env.DEPLOYER_ACCOUNT_ID ?? "<DEPLOYER_ACCOUNT_ID>"}`);
  else console.log(`Transaction (signer ${policyId}, receiver ${policyId}): DeleteKey <deployer public key>`);
  if (!send) {
    console.log("\nDry run: nothing was signed or sent. Re-run with --send to broadcast on MAINNET.");
    return;
  }
  const { DEPLOYER_PRIVATE_KEY } = requireEnv(env, ["DEPLOYER_PRIVATE_KEY"], `deploy-policy --${mode} --send (signs as the policy with the rehearsal key)`);
  const rehearsalKey = publicKeyOf(DEPLOYER_PRIVATE_KEY);
  await assertFullAccessKey(provider, policyId, DEPLOYER_PRIVATE_KEY, "DEPLOYER_PRIVATE_KEY");
  if (keys.length !== 1) {
    throw new Error(`${policyId} has ${keys.length} keys, expected only the rehearsal key ${rehearsalKey}. Remove the others by hand first.`);
  }
  const signer = nearAccount(policyId, DEPLOYER_PRIVATE_KEY, nearUrlsFor(env));
  if (mode === "abort") {
    // Same spirit as the contract's `close`: never delete a rehearsal policy that still holds user money.
    const usdc = await ftBalance(provider, NEAR.usdcToken, policyId);
    if (usdc > 9_999n) throw new Error(`${policyId} still holds ${usdc} USDC units (6 decimals). Withdraw them first (owner: withdraw), then abort.`);
    if (!confirmEmpty) {
      throw new Error(
        `Refusing to abort ${policyId}: its derived loan-chain address may still hold USDC/ETH, which would be stranded under a name only the deployer can recreate. ` +
          "Check it on the chain explorer (policy status prints the address), empty it, then re-run with --confirm-empty.",
      );
    }
    const { DEPLOYER_ACCOUNT_ID } = requireEnv(env, ["DEPLOYER_ACCOUNT_ID"], "deploy-policy --abort --send (the NEAR returns to the deployer)");
    const done = await sendTransaction(signer, policyId, abortActions(DEPLOYER_ACCOUNT_ID));
    console.log(`Sent: ${nearTxUrl(done.txHash)}\n${policyId} is deleted and its NEAR went back to ${DEPLOYER_ACCOUNT_ID}.`);
    return;
  }
  const sent = await sendTransaction(signer, policyId, wasm ? redeployActions(wasm.code) : finalizeActions(rehearsalKey));
  console.log(`Sent: ${nearTxUrl(sent.txHash)}`);
  const [after, account] = await Promise.all([viewAccessKeys(provider, policyId), provider.viewAccount({ accountId: policyId })]);
  if (wasm && account.code_hash !== wasm.codeHash) {
    throw new Error(`code_hash on chain is ${account.code_hash}, expected ${wasm.codeHash}. Check the transaction above.`);
  }
  console.log(`code_hash: ${account.code_hash}`);
  if (mode === "finalize") {
    if (after.length > 0) throw new Error(`DANGER: ${policyId} still has ${after.length} key(s). Do not fund it; re-run --finalize.`);
    console.log(`Key list of ${policyId}: empty. The policy is now keyless and immutable; the agent no longer needs --allow-keyed-rehearsal.`);
  }
}

runMain(async () => {
  const { values, positionals } = parseArgs({
    options: {
      ...LIMIT_OPTIONS,
      ...CHAIN_OPTION,
      name: { type: "string" },
      owner: { type: "string" },
      borrower: { type: "string" },
      agent: { type: "string" },
      wasm: { type: "string" },
      rehearsal: { type: "boolean", default: false },
      redeploy: { type: "string" },
      finalize: { type: "string" },
      abort: { type: "string" },
      "confirm-empty": { type: "boolean", default: false },
      send: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length) throw new Error(`Unexpected arguments: ${positionals.join(" ")}. ${USAGE}`);
  if (values.redeploy !== undefined && values.finalize !== undefined) throw new Error(`Pass --redeploy or --finalize, not both. ${USAGE}`);
  if (values.abort !== undefined) return rehearsalFollowUp("abort", values.abort, undefined, values.send, values["confirm-empty"]);
  if (values.redeploy !== undefined) return rehearsalFollowUp("redeploy", values.redeploy, values.wasm, values.send);
  if (values.finalize !== undefined) return rehearsalFollowUp("finalize", values.finalize, undefined, values.send);
  for (const flag of ["name", "owner", "borrower"] as const) {
    if (values[flag] === undefined) throw new Error(`--${flag} is required. ${USAGE}`);
  }
  const limits = limitsFromFlags(values, DEFAULT_LIMITS);
  const chain = chainFromFlag(values.chain);

  const env = loadEnv();
  const { DEPLOYER_ACCOUNT_ID } = requireEnv(env, ["DEPLOYER_ACCOUNT_ID"], "Creating a policy (the operator account pays for it)");
  const agent = values.agent ?? env.AGENT_ACCOUNT_ID;
  if (agent === undefined) throw new Error(`Pass --agent <agent.near> or set AGENT_ACCOUNT_ID in .env. ${USAGE}`);
  const policyId = policyAccountId(values.name!, DEPLOYER_ACCOUNT_ID, chain);
  // No FEE_ACCOUNT_ID means no fee: the contract still needs an account, so the deployer stands in at 0 bps.
  const feeAccount = env.FEE_ACCOUNT_ID ?? DEPLOYER_ACCOUNT_ID;
  const feeBps = env.FEE_ACCOUNT_ID ? env.FEE_BPS : 0;
  const args = initArgs({ chain, name: values.name!, deployer: DEPLOYER_ACCOUNT_ID, owner: values.owner!, agent, borrower: values.borrower!, limits, feeAccount, feeBps });
  console.log(feeBps === 0 ? "Service fee: none (set FEE_ACCOUNT_ID in .env to charge one)." : `Service fee: ${feeBps} bps (${(feeBps / 100).toFixed(2)}%) of each bridged amount, paid to ${feeAccount}. Fixed for this policy.`);

  const provider = nearProviderFor(env);
  if (await accountExists(provider, policyId)) {
    throw new Error(`${policyId} already exists. Pick another --name (or use --redeploy / --finalize on a rehearsal policy).`);
  }

  const wasmPath = resolveWasm(values.wasm);
  const { code, digest, codeHash } = wasmInfo(wasmPath);
  const rehearsal = values.rehearsal;
  const rehearsalKey = rehearsal && env.DEPLOYER_PRIVATE_KEY ? publicKeyOf(env.DEPLOYER_PRIVATE_KEY) : undefined;

  const [local, onChain, perByte, bounds, deployer] = await Promise.all([
    deriveEvmAddress(chain, policyId, NEAR.derivationPath),
    deriveAddressOnChain(provider, policyId, NEAR.derivationPath),
    storagePerByte(provider),
    viewCall<{ min: string }>(provider, NEAR.usdcToken, "storage_balance_bounds"),
    provider.viewAccount({ accountId: DEPLOYER_ACCOUNT_ID }),
  ]);
  if (local.address !== onChain.address) {
    throw new Error(
      `MISMATCH: chainsig.js derives ${local.address} but ${NEAR.mpcContract}.derived_public_key gives ${onChain.address}. ` +
        "Not deploying: activate would store an address the agent refuses. Check the chainsig.js version and its mainnet root key.",
    );
  }
  const budget = deployBudget(code.length, perByte, BigInt(bounds.min));

  console.log(`Policy account:  ${policyId} (new, ${rehearsal ? "REHEARSAL: temporary full-access key, finalize before real use" : "keyless"})`);
  console.log(`Owner:           ${args.owner}`);
  console.log(`Agent:           ${args.agent}`);
  console.log(`Chain:           ${chain.name} (${chain.chainId}), Aave pool ${chain.aave.pool}, native USDC ${chain.aave.usdc}`);
  console.log(`Borrower (${chain.name}): ${args.on_behalf_of}`);
  console.log(`Derived ${chain.name} address after activate: ${local.address} (chainsig.js and ${NEAR.mpcContract} view agree)`);
  console.log(`Wasm: ${wasmPath}`);
  console.log(`  ${code.length} bytes, sha256 ${digest.toString("hex")}, NEAR code_hash ${codeHash}`);
  console.log("Limits:");
  for (const line of describeLimits(limits)) console.log(`  ${line}`);
  console.log("\nNEAR budget:");
  console.log(`  code storage (held by the policy; the owner gets it back with close): ${formatNear(budget.codeStake)} (${code.length} bytes x ${perByte} yocto/byte)`);
  console.log(`  state margin:                   ${formatNear(budget.stateMargin)}`);
  console.log(`  spare balance:                  ${formatNear(budget.spare)}`);
  console.log(`  -> Transfer to the policy:      ${formatNear(budget.transfer)}`);
  console.log(`  USDC storage_deposit:           ${formatNear(budget.storageDeposit)}`);
  console.log(`  gas reserve:                    ${formatNear(budget.gasReserve)}`);
  console.log(`  NEAR needed on the deployer:    ${formatNear(budget.deployerNeeds)}`);
  console.log(`  deployer ${DEPLOYER_ACCOUNT_ID} holds: ${formatNear(BigInt(deployer.amount))}`);

  console.log(`\nTransaction 1 (signer ${DEPLOYER_ACCOUNT_ID}, receiver ${policyId}):`);
  const steps = [
    "CreateAccount",
    `Transfer        ${formatNear(budget.transfer)} (${budget.transfer} yocto)`,
    ...(rehearsal ? [`AddKey          FullAccess ${rehearsalKey ?? "<public key of DEPLOYER_PRIVATE_KEY>"} (temporary, F2)`] : []),
    `DeployContract  ${code.length} bytes, code_hash ${codeHash}`,
    `FunctionCall    new, gas ${NEW_TGAS} TGas, deposit 0, args:\n${json(args).replace(/^/gm, "       ")}`,
    `FunctionCall    activate, gas ${POLICY.gas.activate} TGas, deposit 0, args: {}`,
  ];
  steps.forEach((step, i) => console.log(`  ${i + 1}. ${step}`));
  console.log(rehearsal ? "  (rehearsal: run deploy-policy --finalize to delete the key)" : "  (no AddKey: the policy account never has a key)");
  console.log(`Transaction 2 (signer ${DEPLOYER_ACCOUNT_ID}, receiver ${NEAR.usdcToken}):`);
  console.log(`  1. FunctionCall    storage_deposit, gas ${POLICY.gas.owner} TGas, deposit ${formatNear(budget.storageDeposit)}, args:`);
  console.log(`       ${JSON.stringify({ account_id: policyId, registration_only: true })}`);

  if (BigInt(deployer.amount) < budget.deployerNeeds) {
    const msg = `${DEPLOYER_ACCOUNT_ID} holds ${formatNear(BigInt(deployer.amount))}; it needs about ${formatNear(budget.deployerNeeds)} plus its own storage. Top it up, then re-run.`;
    if (values.send) throw new Error(msg);
    console.warn(`\nWARN: ${msg}`);
  }
  if (!values.send) {
    console.log("\nDry run: nothing was signed or sent. Re-run with --send to create the policy on MAINNET.");
    return;
  }

  const { DEPLOYER_PRIVATE_KEY } = requireEnv(env, ["DEPLOYER_PRIVATE_KEY"], "deploy-policy --send (signs as the deployer)");
  await assertFullAccessKey(provider, DEPLOYER_ACCOUNT_ID, DEPLOYER_PRIVATE_KEY, "DEPLOYER_PRIVATE_KEY");
  const signer = nearAccount(DEPLOYER_ACCOUNT_ID, DEPLOYER_PRIVATE_KEY, nearUrlsFor(env));
  console.log("\nSending transaction 1 (create + deploy + new + activate)...");
  const created = await sendTransaction(
    signer,
    policyId,
    deployActions(code, args, budget.transfer, rehearsal ? publicKeyOf(DEPLOYER_PRIVATE_KEY) : undefined),
  );
  console.log(`Created: ${nearTxUrl(created.txHash)}`);

  const [keys, account, config] = await Promise.all([
    viewAccessKeys(provider, policyId),
    provider.viewAccount({ accountId: policyId }),
    viewCall<{ base_address: string | null }>(provider, policyId, "get_config"),
  ]);
  const expectedKeys = rehearsal ? [publicKeyOf(DEPLOYER_PRIVATE_KEY)] : [];
  const actualKeys = keys.map((k) => k.publicKey);
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((k) => !expectedKeys.includes(k))) {
    throw new Error(`DANGER: ${policyId} has access key(s) [${actualKeys.join(", ")}], expected [${expectedKeys.join(", ")}]. Do not use or fund this policy.`);
  }
  console.log(rehearsal ? `Key list of ${policyId}: only the rehearsal key ${expectedKeys[0]}.` : `Key list of ${policyId}: empty (keyless).`);
  if (account.code_hash !== codeHash) {
    throw new Error(`code_hash on chain is ${account.code_hash}, expected ${codeHash}. Do not use or fund this policy.`);
  }
  console.log(`code_hash: ${account.code_hash} (matches the wasm)`);
  if (config.base_address?.toLowerCase() !== local.address.toLowerCase()) {
    console.warn(
      `WARN: base_address is ${config.base_address ?? "null"}, expected ${local.address}. activate did not finish: ` +
        `anyone can call it with near-cli-rs: near contract call-function as-transaction ${policyId} activate json-args '{}' ` +
        `prepaid-gas '${POLICY.gas.activate} TGas' attached-deposit '0 NEAR' sign-as <any.near> network-config mainnet sign-with-keychain send`,
    );
  } else {
    console.log(`base_address: ${config.base_address} (activated)`);
  }

  console.log("\nSending transaction 2 (USDC storage_deposit for the policy)...");
  const registered = await functionCall(signer, {
    contractId: NEAR.usdcToken,
    methodName: "storage_deposit",
    args: { account_id: policyId, registration_only: true },
    gas: teraToGas(POLICY.gas.owner),
    deposit: budget.storageDeposit,
  });
  console.log(`Registered on USDC: ${nearTxUrl(registered.txHash)}`);

  const agentKey = env.AGENT_PRIVATE_KEY ? publicKeyOf(env.AGENT_PRIVATE_KEY) : "ed25519:<agent public key>";
  console.log(`\nPolicy: ${nearAccountUrl(policyId)}`);
  console.log(`Next, the agent operator gives ${agent} a key limited to the agent methods on ${policyId}:`);
  console.log(nearCliAgentKey(agent, policyId, POLICY.agentMethods, agentKey));
  if (rehearsal) {
    console.log(`REHEARSAL: run the agent with --allow-keyed-rehearsal; when every step passed: deploy-policy --finalize ${policyId} --send`);
  }
  console.log(`Then the owner deposits NEAR USDC with ft_transfer_call to ${policyId}, and checks it with \`pnpm --filter @backstop/scripts policy status\`.`);
});
