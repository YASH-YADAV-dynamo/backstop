---
title: Overview
description: What Backstop is, what works today, and what is still being built.
order: 1
---

# Overview

**Backstop pulls your money from any chain to save your loan before it gets liquidated.**

> Beta. The smart contracts are not yet audited. Read [Risks and limits](/docs/risks-and-limits) before you deposit.

You have an Aave v3 loan on Base or Arbitrum One and spare money somewhere else. Backstop keeps rescue USDC in a
**policy contract on NEAR** that only you control. When your health factor (HF) falls below your
trigger, an agent moves part of it to your loan chain with NEAR Intents 1Click and repays part of your loan.
The repay transaction is built by the contract and signed by NEAR Chain Signatures, inside limits
you set.

## What you do

1. Connect your NEAR wallet and your EVM wallet at `/app`. No key ever leaves your wallets.
2. Fund your policy: NEAR USDC from your NEAR wallet, or USDC/USDT (and other tokens 1Click swaps)
   from any chain 1Click supports, through a one-time deposit address.
3. Put a little ETH on your policy's address on the loan chain (Base or Arbitrum One) for gas.
4. Set your limits; pause or withdraw any time.

## What makes it safe

- The policy account has **no access keys**: only its code acts.
- It signs only two kinds of loan-chain transactions, built by itself: Aave `repay` for **your** address
  and `approve` of the Aave Pool for at most one day's limit.
- It pays a bridge only for a quote signed by 1Click that sends the USDC to its own address on the loan chain and
  refunds to itself.
- Withdrawals go only to you and work while paused.

## Status

| Part | Status |
| --- | --- |
| Policy contract v2 (limits, signed-quote bridge, repay/approve builder, withdrawals) | Built, 134 unit tests |
| Agent v2 (watch, decide, bridge, rescue, broadcast with retry and resume) | Built, tested with fakes |
| Web: wallets, policy view, owner actions, fund from any chain | Built, not yet tested with real wallets |
| Operator scripts: keyless deploy, rehearsal + finalize, status | Built |
| Mainnet rehearsal run | Pending |
| Sweep of funds at the policy's Base address | Not built |
