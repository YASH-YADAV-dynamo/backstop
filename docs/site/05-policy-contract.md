---
title: Policy contract
description: Every method, check, error code and event of the NEAR policy contract.
order: 5
---

# Policy contract

Rust, near-sdk, `contracts/policy`. One instance per user, deployed with **no access keys**.
Gas in TGas; deposits in yoctoNEAR.

## Init and activation

| Method | Caller | Deposit | Gas | What it does |
| --- | --- | --- | --- | --- |
| `new(owner, agent, on_behalf_of, chain_id, aave_pool, usdc_base, usdc_near, bridge_dest_asset, bridge_signer_pk, mpc_contract, derivation_path, limits)` | creating tx only | 0 | 30 | Stores config; `base_address` stays null. |
| `activate()` | anyone | 0 | 50 | Asks `mpc_contract.derived_public_key` for this account + path and stores the derived Base address. Retryable; once only. |

## Owner methods

All need exactly **1 yoctoNEAR** except `pause` (none), so a function-call key cannot call them.

| Method | Gas | Notes |
| --- | --- | --- |
| `set_limits({ limits })` | 30 | Rejects target ≤ trigger, zero max per rescue, max per rescue > daily cap, zero cooldown, zero fee or gas caps. |
| `set_agent({ agent })` | 30 | The old agent loses access at once. |
| `set_on_behalf_of({ on_behalf_of })` | 30 | The borrower whose debt is repaid. |
| `set_bridge_signer({ public_key })` | 30 | 1Click's quote key (`ed25519:…`), after 1Click rotates it. |
| `pause()` / `unpause()` | 30 | Stops rescues, bridges and agent approvals. |
| `withdraw({ amount })` | 50 | USDC to the owner; works while paused. |
| `withdraw_near({ amount })` | 30 | NEAR to the owner; keeps storage plus 0.2 NEAR. |
| `close()` | 100 | Deletes the policy and sends all its NEAR to the owner. Only while paused, 1 h after the last sign or bridge request, and with under 0.01 USDC left. No beneficiary parameter. |

## Agent methods

| Method | Gas | What it does |
| --- | --- | --- |
| `fund_bridge({ quote, signature })` | 150 | Verifies the 1Click-signed quote and pays its deposit address (storage registration + exact `amountIn`), plus the service fee to the fee account, all in one atomic batch. |
| `rescue({ amount, evm_nonce, max_fee_per_gas, max_priority_fee_per_gas, gas_limit })` | 300 | Builds `repay(usdc_base, amount, 2, on_behalf_of)` to `aave_pool`, has `v1.signer` sign it, returns the signed tx. |
| `approve_pool({ evm_nonce, max_fee_per_gas, max_priority_fee_per_gas, gas_limit })` | 300 | Builds `approve(aave_pool, daily_cap)` on Base USDC; at most once per hour. The owner can call it with 1 yocto, even while paused. |

## Deposits

`ft_on_transfer` keeps USDC (any sender, works while paused) and refunds any other token. A plain
`ft_transfer` of USDC also counts: there is no ledger, the token balance is the balance.

## Views

`get_config()`, `get_limits()`, `get_status()` (today's rescue and bridge spend, remaining budgets,
cooldown ends, counters, last bridge).

## Limits JSON

```json
{
  "trigger_hf_bps": 11000, "target_hf_bps": 13000,
  "max_per_rescue": "5000000", "daily_cap": "10000000",
  "cooldown_secs": 600, "max_fee_per_gas": "1000000000", "max_gas_limit": "400000"
}
```

USDC amounts have 6 decimals. The daily cap resets at UTC midnight, separately for rescues and
bridges.

## Events (NEP-297, standard `backstop`)

`activated`, `limits_updated`, `agent_updated`, `borrower_updated`, `bridge_signer_updated`,
`paused`, `unpaused`, `deposit`, `withdrawn`, `near_withdrawn`, `bridge_requested`, `bridge_funded`,
`bridge_failed`, `rescue_requested`, `rescue_signed`, `rescue_failed`.

## Errors

Every error string starts with a code. Most common:

| Code | Meaning |
| --- | --- |
| `ERR_NOT_OWNER`, `ERR_NOT_AGENT`, `ERR_NOT_AGENT_OR_OWNER` | Wrong caller. |
| `ERR_PAUSED`, `ERR_NOT_ACTIVATED` | Policy is paused or not activated yet. |
| `ERR_ZERO_AMOUNT`, `ERR_OVER_MAX_PER_RESCUE`, `ERR_OVER_DAILY_CAP`, `ERR_COOLDOWN` | Limits. |
| `ERR_FEE_ABOVE_CAP`, `ERR_PRIORITY_FEE_ABOVE_MAX_FEE`, `ERR_GAS_LIMIT_ABOVE_CAP` | Base fee and gas caps. |
| `ERR_APPROVE_TOO_SOON` | `approve_pool` within an hour of the last one. |
| `ERR_QUOTE_*` | A bridge quote failed a check (signature, recipient, refund, assets, loss, freshness, reuse, shape). |
| `ERR_NOT_ENOUGH_GAS` | Attach the gas listed above. |
| `ERR_NEAR_RESERVE` | `withdraw_near` would go below storage plus reserve. |
| `ERR_MPC_SIGN_FAILED`, `ERR_SIGNER_NOT_BASE_ADDRESS` | Chain Signatures failed or returned a wrong signature; the budget is handled as described in the security model. |
