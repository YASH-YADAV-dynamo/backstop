/**
 * Prints the loan-chain address derived from (POLICY_CONTRACT_ID, NEAR.derivationPath), cross-checked
 * against v1.signer's own `derived_public_key` view, plus its ETH and USDC balances.
 *   pnpm --filter @backstop/scripts derive [--account <policy.near>] [--chain base|arbitrum]
 * The address is the same on every EVM chain; --chain picks the RPC for the balances and the explorer link.
 * --account works before the policy exists (the derivation needs only the account id).
 */
import { parseArgs } from "node:util";
import { NEAR, chainAddressUrl, isNearAccountId, loadEnv, requireEnv } from "@backstop/config";
import { erc20Balance } from "@backstop/chains";
import { deriveAddressOnChain, deriveEvmAddress } from "@backstop/signer";
import { CHAIN_OPTION, chainClientFor, chainFromFlag, nearProviderFor, runMain } from "./lib/context.js";
import { eth, usdc } from "./lib/format.js";

runMain(async () => {
  const { values } = parseArgs({ options: { account: { type: "string" }, ...CHAIN_OPTION }, strict: true });
  const chain = chainFromFlag(values.chain);
  const env = loadEnv();
  const accountId = values.account ?? requireEnv(env, ["POLICY_CONTRACT_ID"], "Deriving the loan-chain address (or pass --account)").POLICY_CONTRACT_ID;
  if (!isNearAccountId(accountId)) throw new Error(`--account must be a NEAR account id like alice.backstop.near, got "${accountId}".`);
  const path = NEAR.derivationPath;

  const local = await deriveEvmAddress(chain, accountId, path);
  const onChain = await deriveAddressOnChain(nearProviderFor(env), accountId, path);

  console.log(`Predecessor:         ${accountId}`);
  console.log(`Path:                ${path}`);
  console.log(`chainsig.js (local): ${local.address}`);
  console.log(`${NEAR.mpcContract} view:      ${onChain.address}`);
  if (local.address !== onChain.address || local.publicKey.toLowerCase() !== onChain.publicKey.toLowerCase()) {
    throw new Error(
      `MISMATCH: chainsig.js derives ${local.address} but ${NEAR.mpcContract}.derived_public_key gives ${onChain.address}. ` +
        "Do NOT fund either address; check the chainsig.js version and its mainnet root key.",
    );
  }
  console.log("Match: both derivations agree.");

  const client = await chainClientFor(env, chain);
  const [ethBalance, usdcBalance] = await Promise.all([
    client.getBalance({ address: local.address }),
    erc20Balance(client, chain.aave.usdc, local.address),
  ]);
  console.log(`${chain.name} ETH balance: ${eth(ethBalance)}`);
  console.log(`USDC balance:        ${usdc(usdcBalance, chain)}`);
  console.log(`Explorer (${chain.name}): ${chainAddressUrl(chain, local.address)}`);
});
