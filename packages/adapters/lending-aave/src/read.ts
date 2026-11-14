/** On-chain reads from Aave v3 on one chain; the chain's addresses come from the registry (`LoanChain.aave`). */
import type { Address, PublicClient } from "viem";
import type { AaveChainConfig } from "@backstop/config/registry";
import type { Position } from "@backstop/core";
import { addressesProviderAbi, erc20Abi, oracleAbi, poolAbi } from "./abi.js";

/** `Pool.getUserAccountData(user)` as a core Position (Base values are USD, 8 decimals). */
export async function readPosition(client: PublicClient, aave: AaveChainConfig, user: Address): Promise<Position> {
  const [
    totalCollateralBase,
    totalDebtBase,
    availableBorrowsBase,
    currentLiquidationThreshold,
    ltv,
    healthFactor,
  ] = await client.readContract({
    address: aave.pool,
    abi: poolAbi,
    functionName: "getUserAccountData",
    args: [user],
  });
  return { totalCollateralBase, totalDebtBase, availableBorrowsBase, currentLiquidationThreshold, ltv, healthFactor };
}

/**
 * The Aave price oracle, resolved from the Pool itself
 * (`Pool.ADDRESSES_PROVIDER().getPriceOracle()`), so no oracle address is hardcoded.
 */
export async function aaveOracle(client: PublicClient, aave: AaveChainConfig): Promise<Address> {
  const provider = await client.readContract({
    address: aave.pool,
    abi: poolAbi,
    functionName: "ADDRESSES_PROVIDER",
  });
  return client.readContract({ address: provider, abi: addressesProviderAbi, functionName: "getPriceOracle" });
}

/** USDC price in Aave base currency (USD, 8 decimals), e.g. 99_990_000n = $0.9999. */
export async function usdcPriceBase(client: PublicClient, aave: AaveChainConfig): Promise<bigint> {
  const oracle = await aaveOracle(client, aave);
  const price = await client.readContract({
    address: oracle,
    abi: oracleAbi,
    functionName: "getAssetPrice",
    args: [aave.usdc],
  });
  if (price === 0n) {
    throw new Error(`Aave oracle ${oracle} returned price 0 for USDC; check that the RPC URL points at the right chain.`);
  }
  return price;
}

/**
 * The borrower's USDC variable debt (USDC 6dp): `balanceOf(user)` on Aave's USDC variable debt
 * token. Backstop v2 repays only this debt; a repay with none reverts.
 */
export function usdcVariableDebt(client: PublicClient, aave: AaveChainConfig, user: Address): Promise<bigint> {
  return client.readContract({
    address: aave.usdcVariableDebtToken,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [user],
  });
}
