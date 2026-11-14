import { describe, expect, it } from "vitest";
import { decodeFunctionData, getAddress, toFunctionSelector } from "viem";
import { AAVE_ARBITRUM, AAVE_BASE } from "@backstop/config/registry";
import {
  encodeApprove,
  encodeBorrow,
  encodeDepositETH,
  encodeRepay,
  erc20Abi,
  poolAbi,
  usdcVariableDebt,
  wethGatewayAbi,
} from "../src/index.js";

/** Aave's `USDC` entry on Arbitrum is the bridged USDC.e: Backstop must never use it. */
const USDC_E = { underlying: "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8", vToken: "0xFCCf3cAbbe80101232d343252614b6A3eE81C989" };

const user = getAddress("0x1b48b83a308ea4beb845db088180dc3389f8aa3b");

describe("encodeRepay", () => {
  it("uses the Aave v3 repay selector 0x573ade81", () => {
    expect(toFunctionSelector("repay(address,uint256,uint256,address)")).toBe("0x573ade81");
    expect(encodeRepay(AAVE_BASE.usdc, 1_500_000n, user).slice(0, 10)).toBe("0x573ade81");
  });

  it("decodes back to asset, amount, variable rate mode 2 and onBehalfOf", () => {
    const { functionName, args } = decodeFunctionData({
      abi: poolAbi,
      data: encodeRepay(AAVE_BASE.usdc, 1_500_000n, user),
    });
    expect(functionName).toBe("repay");
    expect(args).toEqual([AAVE_BASE.usdc, 1_500_000n, 2n, user]);
  });
});

describe("other encoders", () => {
  it("borrow is variable rate, no referral, on behalf of the user", () => {
    const { functionName, args } = decodeFunctionData({
      abi: poolAbi,
      data: encodeBorrow(AAVE_BASE.usdc, 2_000_000n, user),
    });
    expect(functionName).toBe("borrow");
    expect(args).toEqual([AAVE_BASE.usdc, 2_000_000n, 2n, 0, user]);
  });

  it("approve targets the spender with the amount", () => {
    const { args } = decodeFunctionData({ abi: erc20Abi, data: encodeApprove(AAVE_BASE.pool, 5n) });
    expect(args).toEqual([AAVE_BASE.pool, 5n]);
  });

  it("depositETH matches depositETH(address,address,uint16)", () => {
    const data = encodeDepositETH(AAVE_BASE.pool, user);
    expect(data.slice(0, 10)).toBe(toFunctionSelector("depositETH(address,address,uint16)"));
    expect(decodeFunctionData({ abi: wethGatewayAbi, data }).args).toEqual([AAVE_BASE.pool, user, 0]);
  });
});

describe("usdcVariableDebt", () => {
  it("reads balanceOf(user) on the USDC variable debt token from the address book", async () => {
    const calls: unknown[] = [];
    const client = {
      readContract: async (args: unknown) => {
        calls.push(args);
        return 1_234_567n;
      },
    } as unknown as Parameters<typeof usdcVariableDebt>[0];
    expect(await usdcVariableDebt(client, AAVE_BASE, user)).toBe(1_234_567n);
    expect(calls).toEqual([
      { address: AAVE_BASE.usdcVariableDebtToken, abi: erc20Abi, functionName: "balanceOf", args: [user] },
    ]);
  });
});

describe("Arbitrum config", () => {
  it("reads the debt of the native USDCn v-token, never the bridged USDC.e one", async () => {
    const calls: { address: string }[] = [];
    const client = {
      readContract: async (args: { address: string }) => {
        calls.push(args);
        return 42n;
      },
    } as unknown as Parameters<typeof usdcVariableDebt>[0];
    expect(await usdcVariableDebt(client, AAVE_ARBITRUM, user)).toBe(42n);
    expect(calls.map((c) => c.address)).toEqual([AAVE_ARBITRUM.usdcVariableDebtToken]);
    expect(AAVE_ARBITRUM.usdcVariableDebtToken).toBe("0xf611aEb5013fD2c0511c9CD55c7dc5C1140741A6");
    expect(AAVE_ARBITRUM.usdcVariableDebtToken).not.toBe(USDC_E.vToken);
  });

  it("repays native USDC (0xaf88...5831) to the Arbitrum Pool, not USDC.e (0xFF97...)", () => {
    expect(AAVE_ARBITRUM.usdc.toLowerCase()).toBe("0xaf88d065e77c8cc2239327c5edb3a432268e5831");
    expect(AAVE_ARBITRUM.usdc).not.toBe(USDC_E.underlying);
    const { args } = decodeFunctionData({ abi: poolAbi, data: encodeRepay(AAVE_ARBITRUM.usdc, 1_000_000n, user) });
    expect(args).toEqual([AAVE_ARBITRUM.usdc, 1_000_000n, 2n, user]);
    expect(AAVE_ARBITRUM.pool).toBe("0x794a61358D6845594F94dc1DB02A252b5b4814aD");
    expect(AAVE_ARBITRUM.pool).not.toBe(AAVE_BASE.pool);
  });
});
