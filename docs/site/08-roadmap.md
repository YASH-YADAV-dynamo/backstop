---
title: Roadmap
description: What is built, what is next, and the longer-term stages.
order: 8
---

# Roadmap

## Now

| Item | State |
| --- | --- |
| Keyless policy contract: limits, 1Click-signed bridge, contract-built repay/approve, withdrawals | Built, 134 unit tests |
| Agent: watch, decide, bridge, rescue, broadcast with retry and resume | Built, tested with fakes |
| Web: wallets, policy checks, owner actions, fund from any chain | Built, not yet tested with real wallets |
| Operator scripts: keyless deploy, rehearsal + finalize | Built |
| First mainnet rehearsal and rescue with tx links | Pending |

## Next

- **Owner controls from any chain.** Aurora Intents Connect lets a wallet on one chain act on
  another, but cannot target NEAR yet. When it can, owners on any chain could pause and withdraw
  without a NEAR wallet.
- **Self-service policies** through a keyless factory contract.
- **One scoped bot key per vault**, added by a provisioning key on a separate host, instead of one bot account that reaches every vault.
- **Sweep** of funds at the policy's Base address back to the borrower (owner only, while paused).
- **One contract for many users** (or NEAR global contracts) to remove the per-user code cost.
- Timelock on limit increases; exact-amount approvals per rescue; nonce-based CSP.
- near-workspaces sandbox tests; agent in a TEE; an audit before real amounts.

## Stages

1. **Backstop rescue** — protect one Aave v3 loan on Base or Arbitrum One with USDC from any chain, under on-chain
   limits. This is what exists today.
2. **Unified risk view** (not built yet) — one view of loans and spare balances across chains; each
   protocol is one adapter (Morpho, Solana lending, perps margin).
3. **Automatic rebalancing** (not built yet) — move spare funds toward risk before the trigger.
4. **Cross-margin account with a liquidity vault** (not built yet) — a vault fronts the repay at
   once and is paid back from the user's funds on other chains.
5. **INR on-ramp** (not built yet) — only after a Compliance and Legal review.
