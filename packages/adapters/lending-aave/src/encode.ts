/** Calldata builders for the Aave v3 Pool, the WETH gateway and ERC-20. */
import { encodeFunctionData, type Address, type Hex } from "viem";
import { erc20Abi, poolAbi, wethGatewayAbi } from "./abi.js";

const NO_REFERRAL = 0;
/** Aave interestRateMode 2 = variable (stable rate is deprecated); the same on every Aave v3 deployment. */
const VARIABLE_RATE = 2n;

/** `Pool.repay(asset, amount, 2, onBehalfOf)`, selector 0x573ade81. */
export function encodeRepay(asset: Address, amount: bigint, onBehalfOf: Address): Hex {
  return encodeFunctionData({
    abi: poolAbi,
    functionName: "repay",
    args: [asset, amount, VARIABLE_RATE, onBehalfOf],
  });
}

/** `Pool.borrow(asset, amount, 2, 0, onBehalfOf)`: variable rate, no referral. */
export function encodeBorrow(asset: Address, amount: bigint, onBehalfOf: Address): Hex {
  return encodeFunctionData({
    abi: poolAbi,
    functionName: "borrow",
    args: [asset, amount, VARIABLE_RATE, NO_REFERRAL, onBehalfOf],
  });
}

/** `ERC20.approve(spender, amount)`. */
export function encodeApprove(spender: Address, amount: bigint): Hex {
  return encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] });
}

/** `WrappedTokenGatewayV3.depositETH(pool, onBehalfOf, 0)`; the ETH goes in the tx value. */
export function encodeDepositETH(pool: Address, onBehalfOf: Address): Hex {
  return encodeFunctionData({
    abi: wethGatewayAbi,
    functionName: "depositETH",
    args: [pool, onBehalfOf, NO_REFERRAL],
  });
}
