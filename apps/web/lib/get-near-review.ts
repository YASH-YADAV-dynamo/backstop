/**
 * "Get NEAR" transactions for the one ReviewDialog: the Base deposit (reuses `prepareFundSend`, so the same
 * checks and the same hardened EVM send path) and the wNEAR unwrap. Plus the balance reads the card needs.
 * Nothing here signs or sends.
 */
import { NEAR_TOPUP_DESTINATION, NEAR_TOPUP_LIMITS, type TopUpOrigin } from "@backstop/config/near-topup";
import { loanChainById } from "@backstop/config/registry";
import { parseAbi, type Address } from "viem";
import { z } from "zod";
import { nearText } from "@/lib/create-vault";
import { tokenText } from "@/lib/get-near";
import { chainClient, readEthBalance } from "@/lib/loan-client";
import { viewAccount, viewFunction } from "@/lib/near-rpc";
import { ONE_YOCTO, type NearTx } from "@/lib/policy-client";
import { prepareFundSend, type Prepared } from "@/lib/review";

/** Gas for wrap.near `near_withdraw` (it is a plain transfer back to the caller). */
export const UNWRAP_TGAS = 10;

export const unwrapTx = (amount: bigint): NearTx => ({
  receiverId: NEAR_TOPUP_DESTINATION.wrapContract,
  calls: [{ methodName: "near_withdraw", args: { amount: amount.toString() }, gasTgas: UNWRAP_TGAS, depositYocto: ONE_YOCTO }],
});

export const readWrappedNear = (accountId: string): Promise<bigint> =>
  viewFunction(NEAR_TOPUP_DESTINATION.wrapContract, "ft_balance_of", { account_id: accountId }, z.string().regex(/^\d+$/)).then(BigInt);

/** The text when the account cannot pay the unwrap's gas: a dead end we say out loud, with the way out. */
export const unwrapGasMessage = (accountId: string): string =>
  `Your NEAR arrived as wrapped NEAR. Turning it into spendable NEAR costs a tiny network fee paid in NEAR, and ${accountId} has less than ${nearText(NEAR_TOPUP_LIMITS.unwrapGasMinYocto, 2)}. Send at least ${nearText(NEAR_TOPUP_LIMITS.unwrapGasMinYocto, 2)} to it (for example from an exchange), then come back to unwrap. The wrapped NEAR stays safe in your account meanwhile.`;

/** Unwrap `amount` wNEAR into native NEAR in the user's own account. Re-reads both balances first. */
export function prepareUnwrap(accountId: string, amount: bigint): Promise<Prepared> {
  return (async (): Promise<Prepared> => {
    const [wrapped, account] = await Promise.all([readWrappedNear(accountId), viewAccount(accountId)]);
    const native = account?.amount ?? 0n;
    if (wrapped <= 0n) return { ok: false, reason: "There is no wrapped NEAR in your account to unwrap." };
    if (native < NEAR_TOPUP_LIMITS.unwrapGasMinYocto) return { ok: false, reason: unwrapGasMessage(accountId) };
    const value = amount < wrapped ? amount : wrapped;
    const txs = [unwrapTx(value)];
    return {
      ok: true,
      network: "near",
      txs,
      fingerprint: `unwrap|${accountId}|${value}`,
      sentence: `Turn ${nearText(value, 4)} of wrapped NEAR into spendable NEAR in ${accountId}.`,
      rows: [
        ["Network", "NEAR mainnet"],
        ["Contract", NEAR_TOPUP_DESTINATION.wrapContract],
        ["Method", "near_withdraw"],
        ["Amount", `${nearText(value, 6)} (wrapped NEAR)`],
        ["Attached deposit", "1 yoctoNEAR (a formality NEAR requires for this kind of call)"],
        ["Gas", `${UNWRAP_TGAS} TGas`],
        ["Account", accountId],
      ],
      dangers: [],
      notes: ["Wrapped NEAR and NEAR are worth the same; this only changes its form so it can pay for your vault."],
    };
  })();
}

export type TopUpSend = {
  origin: TopUpOrigin;
  symbol: string;
  decimals: number;
  contract: string | null;
  depositAddress: string;
  amount: bigint;
  deadline: string;
  recipient: string;
};

/** The Base deposit: exactly `prepareFundSend` (wallet, chain, deadline and address checks), worded for NEAR. */
export function prepareTopUpSend(sender: { address: Address; chainId: number | undefined } | null, input: TopUpSend): Promise<Prepared> {
  return prepareFundSend(sender, {
    chainId: input.origin.evmChainId,
    chainName: input.origin.name,
    symbol: input.symbol,
    decimals: input.decimals,
    contract: input.contract,
    depositAddress: input.depositAddress,
    amount: input.amount,
    deadline: input.deadline,
    policyId: input.recipient,
  }).then((p): Prepared => {
    if (!p.ok) return p;
    const human = tokenText(input.amount, input.decimals, input.symbol, 8);
    return {
      ...p,
      fingerprint: `gn|${p.fingerprint}`,
      sentence: `Send ${human} on ${input.origin.name} to a one-time swap address; it arrives in ${input.recipient} as NEAR.`,
      notes: [...p.notes, "This is a swap with a spread: the NEAR you receive can be a little less than the estimate, never less than the minimum shown."],
    };
  });
}

const erc20 = parseAbi(["function balanceOf(address owner) view returns (uint256)"]);

/** The wallet's balance of each origin asset (smallest units), keyed by asset id. Origin chains are loan chains today. */
export async function readOriginBalances(origin: TopUpOrigin, address: Address): Promise<Record<string, bigint>> {
  const chain = loanChainById(origin.evmChainId);
  const client = chainClient(chain);
  const entries = await Promise.all(
    origin.assets.map(async (a) => [a.assetId, a.contract ? await client.readContract({ address: a.contract, abi: erc20, functionName: "balanceOf", args: [address] }) : await readEthBalance(chain, address)] as const),
  );
  return Object.fromEntries(entries);
}
