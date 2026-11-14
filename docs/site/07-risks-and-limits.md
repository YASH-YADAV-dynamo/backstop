---
title: Risks and limits
description: What can go wrong, what Backstop does not protect against, and what is not verified yet.
order: 7
---

# Risks and limits

**Backstop is in beta. The smart contracts are not yet audited and have not yet run on mainnet. Start with a small amount.**

## What Backstop does not protect against

- **Very fast crashes.** A rescue that needs a bridge takes about a minute (quote, deposit, swap,
  signature, Base inclusion). A faster drop can liquidate first. USDC kept at the policy's Base
  address skips the bridge.
- **The trigger is not enforced on-chain.** NEAR cannot see your Base health factor. The agent
  decides when; the contract enforces how much, how often, where and at what fee.
- **Other debt.** Only USDC variable debt on Aave v3 (Base and Arbitrum One, native USDC) is repaid.
  USDC.e and other tokens are not.
- **The bot being offline.** If the rescue bot is down, stuck or cannot read your loan, nothing is
  repaid, however healthy your vault looks. Your money stays in the vault and you can pause or withdraw.
  You can also set yourself (or another operator) as the agent.

## Trust you still place

- **One bot key reaches all vaults.** To watch every vault within a minute of its creation, a single
  bot account serves them all. The vault still accepts only `rescue`, `fund_bridge` and `approve_pool`
  from the bot, so a stolen bot key could at worst repay each owner's own debt early with their own
  USDC, inside their limits, and bridge their USDC to their own loan wallet. It cannot send money
  anywhere else. Keeping that key off the vaults and scoping one key per vault is on the roadmap.

- **NEAR MPC network** (`v1.signer`): could sign anything for the policy's Base address. Only
  transient USDC and gas ETH sit there; your loan does not.
- **1Click:** holds one bridge amount in flight until it is delivered or refunded.
- **Wallet adapters:** NEAR Connect loads wallet code at runtime. Your wallet's confirmation screen
  is the control: read it.

## Limits of this version

- **Immutable.** The policy cannot be upgraded. If 1Click changes its signed quote format or Aave
  its Pool, bridging or repaying stops; your funds stay withdrawable. Migration = withdraw and
  create a new policy.
- **Held NEAR.** About 2.8 NEAR (~$8) of code storage sits in each policy. The owner gets it back
  with `close` (paused, an hour after the last request, USDC withdrawn). After a close, the operator
  account that created the policy can re-create its name, so empty the policy's Base address first.
  `close` stops working after roughly 120 lifetime bridges (state limit).
- **No sweep yet.** USDC and ETH at the policy's Base address leave only as repayments.
- **Other tokens.** Only USDC (and NEAR) can be withdrawn; do not send other tokens to the policy.
- **Service fee.** 0.10% of each bridged amount (default; the contract caps it at 0.50%), paid to the
  operator's fee account in the same batch as the bridge. It is not refunded if 1Click refunds the swap.
  Rate and account are fixed at creation and visible in `get_config`. It is not counted against
  `daily_cap` or `max_per_rescue`.
- **No timelock.** Limit changes take effect at once.
- **Any-chain deposits** must match the token, chain, amount and deadline shown, or 1Click refunds
  to your refund address (or the funds can be lost).

## Not verified yet (settled by the mainnet rehearsal)

- 1Click accepts a deposit made by a contract and refunds to a contract.
- 1Click delivers any-chain deposits to the policy contract.
- Mainnet gas use of `fund_bridge`, `activate` and `withdraw`.
- Whether NEAR Connect's "Ethereum Wallets" accounts can approve owner actions. The wallet is listed,
  but we claim nothing until it is tested.
- Every wallet against the site's content security policy (shipped report-only until then).
