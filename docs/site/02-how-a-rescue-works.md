---
title: How a rescue works
description: Every step from a falling health factor to a repaid loan, and what is checked where.
order: 2
---

# How a rescue works

Names used below: **policy** = your NEAR policy contract; **derived address** = the Base address
the policy controls through Chain Signatures; **borrower** = your own Base address with the loan.

| # | Step | Who | Checked by |
| --- | --- | --- | --- |
| 1 | **Watch.** Read the borrower's health factor from Aave (`getUserAccountData`) every 30 s. | Agent | — |
| 2 | **Decide.** If HF < trigger, compute the USDC repay that brings HF to the target, capped by `max_per_rescue`, today's remaining budget and the borrower's USDC debt. | Agent (pure risk engine) | Contract limits (step 5) |
| 3 | **Allowance.** If the derived address has not approved enough USDC to the Aave Pool, call `approve_pool`: the policy builds `approve(Aave Pool, daily_cap)`, has it signed, the agent broadcasts. | Agent → policy → `v1.signer` | Policy: once per hour, exact amount, exact spender |
| 4 | **Bridge (only if Base USDC is short).** The agent gets a 1Click quote NEAR USDC → Base USDC with recipient = derived address and refund = policy, and calls `fund_bridge(quote, signature)`. The policy verifies 1Click's signature and every field, then pays the deposit address. 1Click delivers Base USDC to the derived address. If a bridge is already in flight, the agent waits for it instead of quoting again. | Agent → policy → 1Click | Policy: signature, recipient, refund, assets, ≤2% loss, freshness, single use, bridge budget and cooldown |
| 5 | **Rescue.** The agent calls `rescue(amount, nonce, fees, gas)`. The policy checks pause, amount, daily cap, cooldown, fee and gas caps, reserves the budget, builds `repay(USDC, amount, 2, borrower)` to the Aave Pool with value 0, and asks `v1.signer` to sign its hash. | Agent → policy → `v1.signer` | Policy |
| 6 | **Verify.** The policy ecrecovers the signature against the derived address and returns the signed tx. The agent checks it again (to, data, nonce, signer). | Policy, agent | Both |
| 7 | **Broadcast.** The agent sends the tx to Base (retrying a flaky RPC; a signed repay that could not be sent is retried on the next pass while its nonce is current), waits for it and re-reads HF. | Agent | Base |
| 8 | **Record.** Rescue record with HF before/after and tx links; a short receipt from NEAR AI Cloud (template fallback). | Agent | — |

If 1Click is down or slow, the agent repays with whatever USDC is already on Base. USDC kept at the
derived address ahead of time removes the bridge from the critical path entirely.

If a signature fails, the budget is rolled back. If you pause the policy, rescues and bridges stop;
withdrawals still work.
