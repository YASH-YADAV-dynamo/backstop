---
title: Security model
description: Who holds which key, what each can do, and the worst case if each is compromised.
order: 4
---

# Security model

> Beta. The smart contracts are not yet audited. Read [Risks and limits](/docs/risks-and-limits) before you deposit.

## No user keys, anywhere

You never type, paste or export a key. Every action is a transaction you approve in your own
wallet. The site never asks for a NEAR function-call key.

## Keys

| Key | Where | Can | Cannot |
| --- | --- | --- | --- |
| Your NEAR wallet (owner) | your wallet | Set limits, agent, borrower; pause; unpause; withdraw to yourself. All but `pause` need 1 yoctoNEAR. | Send a withdrawal anywhere else. |
| Your EVM wallet (borrower) | your wallet | Manage your loan. | — |
| Agent key | operator's host | `rescue`, `fund_bridge`, `approve_pool`, within your limits. | Move funds to anyone; choose a Base tx's target or calldata; choose a bridge recipient. |
| Policy account | **no keys** | — | Nobody can sign as it or change its code. |

The safety claim is about what the vault accepts, not about which key type the bot uses: the vault accepts only
`rescue`, `fund_bridge` and `approve_pool` from the bot. When one bot account serves many vaults, its key
reaches all of them, but still only through those three methods and inside each owner's limits (see
[Risks and limits](/docs/risks-and-limits)).

## What the contract checks

- **Base txs:** only `repay(USDC, amount, 2, your address)` to the Aave Pool and
  `approve(Aave Pool, daily_cap)`, value 0, with capped fee and gas; the MPC signature must recover
  to the policy's Base address.
- **Bridges:** 1Click's ed25519 signature over the exact quote; recipient = the policy's Base
  address; refund = the policy; USDC → Base USDC; `EXACT_INPUT`; ≤2% loss; fresh; single use;
  unknown fields rejected.
- **Limits:** pause, max per rescue, daily cap (rescues and bridges separately, UTC day), cooldowns
  that cannot be zero, approve at most hourly.

## Worst cases

| If this is compromised | The worst it can do | What you do |
| --- | --- | --- |
| Agent key or host | Repay your debt early and move up to your daily cap per day to the policy's Base address, losing up to 2% of each bridge to fees, plus the service fee (at most 0.5%, outside the daily cap). Not theft. | Pause (one click), then change the agent. |
| This website | Show wrong data or propose a harmful transaction, which you must approve in your wallet. | Read the wallet prompt. |
| 1Click (with the agent key) | Up to the daily cap per day until you pause. | Pause. |
| MPC network | Take what sits at the policy's Base address (transient USDC, gas ETH). Your loan is not there. | Keep that balance small. |

## First deploy

The first mainnet policy is a **rehearsal** with one temporary key, so a bug can be fixed. After
every step has been tested, the key is deleted and the policy becomes keyless for good. The agent
and the site refuse a policy that still has a key (the agent only with an explicit rehearsal flag).

Full model, review findings and residual risks: `docs/SECURITY.md` in the repository.
