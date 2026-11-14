/**
 * Read-only view of an Aave v3 position on Base (default) or Arbitrum.
 *   pnpm --filter @backstop/scripts aave-setup status                 (the policy's derived address)
 *   pnpm --filter @backstop/scripts aave-setup status --address 0x..  (any address, e.g. the borrower)
 *   ... --chain arbitrum   reads the native-USDC (USDCn) market on Arbitrum One
 * v2 never signs loan-chain transactions from scripts: the borrower opens and manages the loan in their
 * own wallet, and only the policy contract can have v1.signer sign for the derived address.
 */
import { parseArgs } from "node:util";
import { getAddress, isAddress, type Address, type PublicClient } from "viem";
import { chainAddressUrl, loadEnv, type LoanChain } from "@backstop/config";
import { erc20Balance } from "@backstop/chains";
import { readPosition, usdcPriceBase, usdcVariableDebt } from "@backstop/lending-aave";
import { CHAIN_FLAG_HELP, CHAIN_OPTION, chainClientFor, chainFromFlag, runMain, scriptContext } from "./lib/context.js";
import { bps, eth, hf, usd8, usdc } from "./lib/format.js";

const USAGE = `Usage: aave-setup status [--address 0x..] [${CHAIN_FLAG_HELP}]`;

async function status(addressArg: string | undefined, chain: LoanChain) {
  let user: Address;
  let client: PublicClient;
  if (addressArg !== undefined) {
    if (!isAddress(addressArg)) throw new Error(`--address must be a 0x EVM address, got "${addressArg}". ${USAGE}`);
    user = getAddress(addressArg);
    client = await chainClientFor(loadEnv(), chain);
  } else {
    const ctx = await scriptContext("aave-setup status (without --address)", chain);
    user = ctx.derived;
    client = ctx.client;
  }
  const [p, price, debt, usdcBal, ethBal] = await Promise.all([
    readPosition(client, chain.aave, user),
    usdcPriceBase(client, chain.aave),
    usdcVariableDebt(client, chain.aave, user),
    erc20Balance(client, chain.aave.usdc, user),
    client.getBalance({ address: user }),
  ]);
  console.log(`Aave v3 ${chain.name} position of ${user}`);
  console.log(`  Health factor:          ${hf(p.healthFactor)}`);
  console.log(`  Collateral:             ${usd8(p.totalCollateralBase)}`);
  console.log(`  Debt:                   ${usd8(p.totalDebtBase)} (USDC variable debt ${usdc(debt, chain)})`);
  console.log(`  Available to borrow:    ${usd8(p.availableBorrowsBase)}`);
  console.log(`  Liquidation threshold:  ${bps(p.currentLiquidationThreshold)}`);
  console.log(`  LTV:                    ${bps(p.ltv)}`);
  console.log(`  USDC oracle price:      ${usd8(price)}`);
  console.log(`  Wallet:                 ${eth(ethBal)}, ${usdc(usdcBal, chain)}`);
  console.log(`  Explorer:               ${chainAddressUrl(chain, user)}`);
}

runMain(async () => {
  const { values, positionals } = parseArgs({
    options: { address: { type: "string" }, ...CHAIN_OPTION },
    allowPositionals: true,
    strict: true,
  });
  const [command, ...extra] = positionals;
  if (extra.length) throw new Error(`Unexpected arguments: ${extra.join(" ")}. ${USAGE}`);
  if (command !== "status") {
    throw new Error(
      `${command ? `"${command}" is not a command. ` : ""}${USAGE}\n` +
        "approve / supply / borrow were removed in v2: the borrower uses their own wallet for the loan, and the " +
        "policy's agent calls approve_pool for the derived address.",
    );
  }
  return status(values.address, chainFromFlag(values.chain));
});
