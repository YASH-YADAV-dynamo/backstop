---
title: Architecture
description: The pieces, where each runs, and how money moves between them.
order: 3
---

# Architecture

```
User's wallets ── NEAR wallet (owner) · EVM wallet (borrower)
        │ approve every action
        ▼
NEAR:  policy contract (no keys) ── v1.signer (MPC) ── USDC token ── 1Click deposit address
        ▲ rescue / fund_bridge / approve_pool
Agent (operator, limited function-call key)
        │ broadcast
        ▼
Base:  derived address (no private key) ── repay on behalf of ──▶ borrower's Aave loan
```

## Components

| Component | Where | Role |
| --- | --- | --- |
| `contracts/policy` | NEAR, one per user, keyless | Holds rescue USDC, enforces limits, verifies 1Click quotes, builds and signs the two allowed Base txs. |
| `apps/agent` | Operator host | Watch → decide → bridge → rescue → broadcast → record. Holds only a function-call key. |
| `apps/web` | Vercel | Landing, `/app` (wallets, policy, deposit, fund from any chain, owner actions), `/dashboard`, `/docs`. No secrets. |
| `packages/core` | library | Types and the pure risk engine. |
| `packages/adapters/lending-aave` | library | Aave v3: positions, oracle price, calldata. |
| `packages/mover` | library | 1Click quotes, signed-quote verification, status. |
| `packages/chains`, `signer`, `db`, `receipts`, `config` | libraries | RPC with failover, derivation, rescue records, AI receipts, registry. |

Adding another lending protocol or chain means one new adapter, not a rewrite.

## Money flow

1. **In:** owner `ft_transfer_call` of NEAR USDC to the policy, or a 1Click deposit from any chain
   that delivers NEAR USDC to the policy.
2. **To Base:** `fund_bridge` pays a 1Click deposit address; 1Click delivers Base USDC to the
   derived address (refunds go back to the policy).
3. **Repay:** the derived address repays the borrower's USDC variable debt on Aave.
4. **Out:** `withdraw` / `withdraw_near` to the owner only.

Method, error and event reference: [Policy contract](05-policy-contract.md).
