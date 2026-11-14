# Backstop: cross-chain liquidation protection with on-chain limits

*Litepaper · November 2026 · Hackathon prototype, unaudited*

## 1. Abstract

Backstop pulls your money from any chain to save your loan before it gets liquidated. The
prototype protects an Aave v3 loan on Base. When the loan's health factor falls below a trigger the
user chose, an off-chain agent moves the user's spare USDC from NEAR to Base with NEAR Intents
1Click and repays part of the loan. The repay transaction is built and signed on NEAR: a policy
contract enforces the user's limits (trigger, maximum per rescue, daily cap, cooldown, pause, fee
and gas caps), builds the only transaction it is allowed to sign — Aave `repay` on behalf of the
user's address — and gets it signed by NEAR Chain Signatures. The loan sits at a Base address
derived from the contract account, so no Base private key exists. A stolen agent key can, at worst,
repay the user's own debt with the user's own funds, within the user's limits.

## 2. Problem

**Collateral is fragmented.** A DeFi user often has a loan on one chain and idle stablecoins on
another. When the loan's collateral price drops, the money that could save it is on the wrong
chain. Moving it by hand means bridging, waiting, switching wallets and signing a repay — often at
night, during a fast market.

**Liquidation is expensive.** On Aave v3, a position becomes liquidatable when its health factor
falls below 1. Liquidators repay part of the debt and take collateral plus a liquidation bonus, so
the borrower loses more than the debt repaid. Repaying a small amount earlier avoids that loss.

**Market crashes are fast and large.** On 10 October 2025, about $19 billion of leveraged crypto
positions were liquidated within 24 hours, the largest liquidation event on record
([Decrypt, Oct 2025](https://decrypt.co/343941/bitcoin-ethereum-dogecoin-down-record-19-billion-crypto-liquidations)).
Most of that was leveraged trading positions on exchanges rather than lending loans, but it shows
how quickly collateral can fall and how many positions can be caught.

**Automation usually means giving away keys.** A bot that can repay your loan on your behalf
usually holds a key that can also move your funds. The user has to trust the bot completely.

## 3. Design

Architecture diagrams: [ARCHITECTURE.md](ARCHITECTURE.md#diagrams).

Backstop splits the work across three trust zones.

**NEAR mainnet** holds the rules and the signing path.
- The *owner account* holds spare USDC and sets the limits.
- The *policy contract* stores the limits and is the only path to a signature for the Base address.
- The *agent account* has a function-call key that can call only `rescue`, `fund_bridge` and
  `approve_pool` on the policy contract.
- The policy contract holds the user's rescue USDC on NEAR and has **no access keys**; only its code acts.
- The *MPC signer* `v1.signer` (Chain Signatures) signs for addresses derived from the calling
  account and a path.

**The off-chain agent worker** watches and acts: watcher → risk engine → mover (1Click) → rescue
caller → broadcaster → record and receipt. It is thin glue over tested packages. (The worker is built and tested with fakes; it has not run on mainnet yet.)

**Base mainnet** holds the loan, at the user's own address (the *borrower*).
- The *derived Base address* is computed from the policy contract account and the path
  `backstop-base-1`. Nobody has its private key; signatures come only from the MPC network when the
  policy contract asks. It receives bridged USDC and repays **on behalf of** the borrower.
- The *Aave v3 Pool* holds the position: collateral and USDC variable-rate debt.

**NEAR Intents 1Click** moves USDC from NEAR to Base. The policy pays a deposit address only for a
quote signed by 1Click that delivers to the derived address and refunds to the policy. Users can
also fund the policy from any chain 1Click supports through a one-time deposit address.

The key design choice: **the contract builds the transaction.** The agent never hands the contract
a transaction to sign. It supplies an amount, a nonce and fee parameters, all bounded by the limits.
The contract builds `repay(usdc, amount, 2, borrower)` to the Aave Pool with zero value, has it
signed, checks the signature with `ecrecover`, and returns the raw transaction for anyone to
broadcast.

## 4. Rescue logic

**Trigger.** The agent reads `getUserAccountData` for the borrower. The health factor is
1e18-scaled. If it is below `trigger_hf_bps` (for example 11000 = 1.10), a rescue is considered.

**Amount.** The risk engine computes how much USDC brings the health factor to `target_hf_bps`.
With Aave values in USD (8 decimals), liquidation threshold `LT` in basis points and the target
`t` in basis points:

```
R = debt - collateral * LT_bps / t
amountUsdc = ceil((debt * t - collateral * LT_bps) * 10^6 / (t * usdcPriceBase))
```

All arithmetic is integer, divided once and rounded up, so repaying `amountUsdc` reaches the target
and one unit less does not. A test checks this on several positions, and a worked example ($30
collateral, $20 debt, LT 83%, target 1.5, USDC at $0.9999) gives 3.400341 USDC.

**Caps.** The amount is `min(needed, max_per_rescue, remaining_today)`.

**Cooldown.** After a rescue, the next one is allowed only `cooldown_secs` later. The cooldown is
reserved when the signature is requested, so two rescues cannot race.

**UTC-day cap.** `spent_today + amount <= daily_cap`. The day starts at UTC midnight, so the budget
resets at 00:00 UTC, not 24 hours after the last rescue.

**Fee and gas caps.** `max_fee_per_gas <= cap`, `max_priority_fee_per_gas <= max_fee_per_gas`,
`gas_limit <= max_gas_limit`. This bounds the L2 gas the derived address can spend per rescue.

**Where it is enforced.** The agent applies these rules off-chain to avoid asking for a rescue that
would fail. The policy contract applies them again on-chain, where they cannot be skipped.

**Funding.** If the derived address already holds enough USDC, there is no bridge step. If not, the
agent requests an EXACT_INPUT 1Click quote from the policy's USDC and calls `fund_bridge`. The
policy verifies 1Click's signature and every routing field (recipient = derived address, refund =
policy, at most 2% loss, fresh, single use), pays the deposit address from its own balance within
the bridge limits, and the agent waits for delivery. No owner key is involved.

## 5. Security model

**Keys.**
- Owner (the user's NEAR wallet): sets limits, pauses, withdraws, always with 1 yoctoNEAR (except
  `pause`) so no browser-held key can act silently. Users never share a key.
- Agent (function-call key): can call `rescue`, `fund_bridge` and `approve_pool` only. It cannot
  transfer funds, call owner methods, attach a deposit, or choose a destination or calldata.
- Policy contract account: **no keys at all**. The only signable transactions are `repay` for the
  borrower and `approve(Aave Pool, daily_cap)`.

**Signature checks.** The contract checks that the MPC signature recovers to `base_address`,
normalises `s` to low-s (Ethereum rejects high-s), and encodes `r` and `s` minimally.

**Rollback.** If signing fails, the reserved budget, cooldown and counter are restored in the
callback, and a follow-up call panics so the agent's transaction fails visibly. The rollback stays
committed.

**Worst case with a stolen agent key.** Bridge up to `daily_cap` USDC per UTC day to the derived
address (where it can only repay the borrower's debt), repay early, lose up to 2% of each bridge to
fees, and burn capped gas. Not theft of principal. Base's L1 data fee is not capped by the contract.

**Trust.** The NEAR MPC network (could sign anything for derived keys), 1Click solvers (custody
during the swap), the Base sequencer (can delay, cannot alter), the Aave oracle (defines the health
factor), and the agent host (availability only: it holds no key that can move funds).

The full model is in [SECURITY.md](SECURITY.md).

## 6. Evaluation

No mainnet rescue has run yet. The table below will be filled from the first runs, each value
linked to its transaction.

| Metric | Value | Evidence |
| --- | --- | --- |
| Health factor before → after | Pending first mainnet run | <!-- MAINNET: fill after first rescue --> |
| Trigger → repay mined | Pending first mainnet run | <!-- MAINNET: fill after first rescue --> |
| 1Click deposit → USDC on Base | Pending first mainnet run | <!-- MAINNET: fill after first rescue --> |
| NEAR `rescue` gas used | Pending first mainnet run | <!-- MAINNET: fill after first rescue --> |
| Base repay gas used and fee | Pending first mainnet run | <!-- MAINNET: fill after first rescue --> |
| 1Click fee | Pending first mainnet run | <!-- MAINNET: fill after first rescue --> |

**One measured data point (a dry quote, not a rescue).** On 2026-11-11/12, a live 1Click dry quote
for NEAR USDC → Base USDC, EXACT_OUTPUT, 2.000000 USDC out, with the default 50 bps slippage,
returned an input of 2.012702 USDC and a `timeEstimate` of 22 seconds. A dry quote moves no funds
and creates no deposit address.

**Tests.** The policy contract has unit tests named after the claim each proves (limits, caller
checks, tx shape, signature recovery, low-s, rollback). The TypeScript packages have vitest tests
for the risk engine, 1Click validation, receipts and the store. The mapping from claim to code to
test is in [JUDGES.md](JUDGES.md).

## 7. Limitations

- **Speed.** A rescue that needs a bridge waits for the 1Click swap. A crash faster than that can
  liquidate first. Keeping some USDC on Base removes the swap from the critical path.
- **Unverified on mainnet.** The MPC response parser, gas use and 1Click's handling of
  contract-made deposits are checked by the mainnet rehearsal (first policy keyed, then finalized).
- **Pause is not retroactive.** A rescue requested before `pause()` still returns a signed tx.
- **Budget spent on Base failures.** If the signed tx is not broadcast or reverts, the budget and
  cooldown stay used.
- **Agent availability.** If the agent is down, nothing is rescued; the user can set another agent. No TEE.
- **One protocol.** Aave v3 USDC debt on Base; funded from NEAR or any chain 1Click supports.
- **Unaudited.** Use small amounts.

## 8. Roadmap and vision

Each stage is a separate step. Only stage 1 is being built now.

1. **Backstop rescue** (this prototype): protect one Aave loan on Base with USDC from NEAR, under
   on-chain limits.
2. **Unified risk view** (not built yet): one dashboard of loans and spare balances across chains,
   with one adapter per protocol (Morpho, Solana lending, perps margin).
3. **Automatic rebalancing** (not built yet): move spare funds ahead of risk, not only at the
   trigger, so rescues need no bridge.
4. **Cross-margin account with a liquidity vault** (not built yet): a vault fronts the repay
   instantly and is paid back from the user's funds on other chains.
5. **INR on-ramp** (not built yet): only after a Compliance and Legal review.

**Hard problems.** Cross-margining needs credit: a vault that fronts liquidity takes risk on the
user's other balances, and that risk must be priced and limited. Speed: rescues must land before
liquidators, which pushes toward pre-positioned liquidity. Regulation: fiat on-ramps and anything
that looks like lending to users need licences, which is why stage 5 waits for review.

## 9. References

- NEAR Intents and 1Click API: <https://docs.near-intents.org>
- NEAR Chain Signatures: <https://docs.near.org/chain-abstraction/chain-signatures>
- chainsig.js: <https://github.com/NearDeFi/chainsig.js>
- omni-transaction-rs: <https://github.com/near/omni-transaction-rs>
- Aave v3 documentation: <https://aave.com/docs>
- aave-address-book: <https://github.com/aave-dao/aave-address-book>
- NEAR AI Cloud: <https://docs.near.ai>
- Base documentation: <https://docs.base.org>
- Decrypt, "Bitcoin, Ethereum, Dogecoin Down Bad Amid Record $19 Billion in Crypto Liquidations",
  Oct 2025: <https://decrypt.co/343941/bitcoin-ethereum-dogecoin-down-record-19-billion-crypto-liquidations>
