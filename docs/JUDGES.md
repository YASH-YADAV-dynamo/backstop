# For judges: claim → code → test → tx

Every claim points at the code that implements it and the test that proves it. Line numbers are
the start of the function or test in this commit. Paths are relative to the repo root.

- Contract tests: `contracts/policy/src/tests.rs` (written `T:<line>` below) — `pnpm contract:test`.
- TypeScript tests: `pnpm test` (vitest, all packages, agent, scripts, web).
- **Tx links:** nothing has run on mainnet yet. Every tx column says *pending* until the rehearsal
  run (see SECURITY.md) fills it.

> Hackathon prototype, unaudited. Use tiny amounts.

## Keys and access (`contracts/policy/src/lib.rs`)

| # | Claim | Code | Test | Tx |
| --- | --- | --- | --- | --- |
| K1 | The policy account is created with no access key, in one transaction that also deploys, initialises and activates it. | `scripts/src/lib/deploy-plan.ts` `deployActions`, `scripts/src/deploy-policy.ts` (post-check: key list empty, code hash) | `scripts/test/deploy-plan.test.ts:27` "never AddKey" | pending |
| K2 | A rehearsal policy has exactly one temporary key, and `--finalize` deletes it. | `deploy-plan.ts` `deployActions(.., rehearsalKey)`, `finalizeActions` | `deploy-plan.test.ts:35`, `:44` | pending |
| K3 | The agent refuses a policy with access keys (exactly one only with `--allow-keyed-rehearsal`). | `apps/agent/src/checks.ts` `assertConfigMatches` | `apps/agent/test/checks.test.ts:16` | — |
| K4 | Owner methods that loosen anything need exactly 1 yoctoNEAR, so a function-call key cannot call them; `pause` needs none. | `lib.rs:373-382` (`assert_owner_one_yocto`), `lib.rs:423` | `owner_methods_require_one_yocto_so_function_call_keys_cannot_use_them` T:589, `pause_needs_no_deposit` T:628 | — |
| K5 | Only the owner can set limits, agent, borrower, bridge signer, pause, unpause, withdraw. | `lib.rs:384-466` | `only_owner_can_set_limits` T:638, `only_owner_can_pause` T:682, `only_owner_can_unpause` T:690, `only_owner_can_set_agent` T:700, `only_owner_can_set_on_behalf_of` T:722, `only_owner_can_set_bridge_signer` T:750, `only_owner_can_withdraw` T:780 | — |
| K6 | Only the agent can call `rescue` and `fund_bridge`; rotating the agent removes the old one. | `lib.rs:497`, `lib.rs:615` | `only_agent_can_call_rescue` T:912, `owner_cannot_call_rescue_unless_agent` T:920, `only_agent_can_fund_bridge` T:1642, `owner_can_rotate_agent_and_old_agent_loses_access` T:707 | — |

## Deposits and withdrawals

| # | Claim | Code | Test | Tx |
| --- | --- | --- | --- | --- |
| W1 | Withdrawals go only to the owner (no recipient parameter) and work while paused. | `lib.rs:438` `withdraw`, `lib.rs:466` `withdraw_near` | `withdraw_sends_usdc_only_to_owner` T:787, `withdraw_works_while_paused` T:813 | pending |
| W2 | `withdraw_near` keeps storage plus a reserve. | `lib.rs:466` | `withdraw_near_keeps_storage_and_reserve` T:849 | — |
| W3 | USDC deposits are kept, other tokens sent with `ft_transfer_call` are refunded, deposits work while paused and before activation. | `lib.rs:485` | `ft_on_transfer_keeps_usdc_and_emits_deposit` T:877, `ft_on_transfer_refunds_any_other_token` T:887, `ft_on_transfer_works_while_paused_and_before_activation` T:895 | pending |
| W5 | The service fee is paid in the same atomic batch as the bridge, is rounded down, and is added on top of the swap amount. | `lib.rs` `fund_bridge` (fee batch) | `bridge_pays_the_service_fee_to_the_fee_account_in_the_same_atomic_batch`, `fee_is_rounded_down_and_a_sub_unit_fee_adds_no_calls`, `zero_fee_bps_charges_nothing_and_adds_no_calls` | pending |
| W6 | The fee rate is capped at 50 bps by the contract, cannot be changed after creation, and is visible in `get_config`. | `lib.rs` `new`, `MAX_FEE_BPS` | `the_fee_rate_is_capped_at_50_bps_by_the_contract`, `the_fee_rate_and_account_are_in_get_config_and_cannot_be_changed`, `the_fee_account_cannot_be_the_policy_itself` | — |
| W7 | `close` is owner-only with exactly 1 yocto, needs a paused policy, a one-hour quiet period and under 0.01 USDC left, sends everything to the owner, and has no beneficiary parameter. | `lib.rs` `close`, `on_close_balance`, `assert_closable` | `only_owner_with_one_yocto_can_close`, `close_requires_a_paused_policy`, `close_waits_one_hour_after_a_rescue_approve_or_bridge_request`, `close_is_refused_while_usdc_is_left_but_dust_cannot_block_it`, `close_callback_is_private_and_takes_no_beneficiary` | pending |
| W4 | `withdraw` and the bridge batch give their outbound calls all unused gas (review F1). | `lib.rs:438`, `lib.rs:497` (`function_call_weight`) | covered by the rehearsal run | pending |

## Activation

| # | Claim | Code | Test | Tx |
| --- | --- | --- | --- | --- |
| A1 | The derived Base address is computed on-chain from `v1.signer.derived_public_key` for this account and path; never passed in. | `lib.rs:340` `activate`, `lib.rs:360` `on_derived_key` | `activate_asks_mpc_for_the_key_derived_from_this_account_and_path` T:448, `activation_sets_base_address_from_mpc_public_key` T:466 | pending |
| A2 | Nothing signs or bridges before activation; a failed activation can be retried; activating twice is rejected. | `lib.rs:340-372` | `rescue_before_activation_is_rejected` T:424, `fund_bridge_before_activation_is_rejected` T:432, `activation_with_malformed_mpc_key_is_rejected_and_can_be_retried` T:477, `activate_twice_is_rejected` T:504 | — |
| A3 | chainsig.js and `v1.signer` agree on the derived address (vector `example.near` + `ethereum-1`). | `packages/signer/src/derive.ts` | `packages/signer/test/derive.test.ts` | — |

## Bridge: the policy pays only 1Click-signed quotes (`contracts/policy/src/bridge.rs`)

| # | Claim | Code | Test | Tx |
| --- | --- | --- | --- | --- |
| B1 | The quote must carry a valid ed25519 signature of 1Click over its exact bytes. | `bridge.rs:98` `verify_quote_signature` | `quote_with_invalid_signature_is_rejected` T:1670, `quote_signed_by_another_key_is_rejected` T:1693, `tampered_quote_is_rejected` T:1702 | — |
| B2 | A recorded **live** 1Click quote passes the on-chain checks, the 1Click SDK and our independent verifier. | `bridge.rs:123` `check_quote`, `packages/mover/src/signed-quote.ts` | `live_1click_quote_fixture_verifies` T:1731, `packages/mover/test/signed-quote.test.ts:36`, `:40` | — |
| B3 | Recipient must be the policy's Base address, refund the policy, USDC → Base USDC, `EXACT_INPUT`, not dry. | `bridge.rs:123` | `quote_with_wrong_recipient_is_rejected` T:1781, `quote_with_refund_to_other_account_is_rejected` T:1798, `quote_with_wrong_origin_asset_is_rejected` T:1805, `quote_with_wrong_destination_asset_is_rejected` T:1812, `dry_quote_is_rejected` T:1819, `exact_output_quote_is_rejected` T:1826, `quote_with_other_routing_types_is_rejected` T:1833 | — |
| B4 | Unknown fields, custom recipient messages, virtual-chain recipients and deposit memos are rejected (fail closed). | `bridge.rs:123` | `quote_with_unknown_field_is_rejected` T:1870, `quote_with_custom_recipient_msg_is_rejected` T:1846, `quote_with_virtual_chain_recipient_is_rejected` T:1853, `quote_with_deposit_memo_is_rejected` T:1863 | — |
| B5 | At most 2% loss; fresh; deposit address not about to expire; each quote usable once. | `bridge.rs:123`, `lib.rs:497` | `quote_losing_more_than_two_percent_is_rejected` T:1912, `stale_quote_is_rejected` T:1924, `quote_from_the_future_is_rejected` T:1938, `quote_whose_deposit_address_expires_soon_is_rejected` T:1949, `same_quote_cannot_be_used_twice` T:1963 | — |
| B6 | Bridges have their own `max_per_rescue`, daily cap (UTC day) and cooldown, separate from rescues. | `limits.rs` `check_bridge` | `bridge_cannot_exceed_max_per_rescue` T:1976, `bridge_cannot_exceed_daily_cap` T:1995, `bridge_daily_cap_resets_next_utc_day` T:2008, `bridge_cooldown_blocks_a_second_bridge` T:2021, `bridge_budget_is_separate_from_rescue_budget` T:2043 | — |
| B7 | The policy registers the deposit address and transfers exactly `amountIn` in one batch; a failed transfer rolls back the budget. | `lib.rs:497-565` | `fund_bridge_registers_deposit_address_and_transfers_exact_amount_in_one_batch` T:2060, `failed_bridge_transfer_rolls_back_bridge_budget_and_fails_the_transaction` T:2090 | pending |

## Rescue: the contract builds and checks every Base transaction (`evm.rs`, `lib.rs`)

| # | Claim | Code | Test | Tx |
| --- | --- | --- | --- | --- |
| R1 | The contract builds `repay(usdc, amount, 2, borrower)` to the Aave Pool, `value = 0`; the borrower is the user's own address, not the derived one. | `evm.rs:63` `encode_repay`, `evm.rs:105` | `contract_builds_repay_on_behalf_of_borrower_only` T:1096, `repay_calldata_is_abi_encoded` T:332, `repay_selector_is_keccak_of_signature` T:308 | pending |
| R2 | `approve_pool` approves exactly `daily_cap` to the Aave Pool, at most once per hour. | `lib.rs:656`, `evm.rs:74` | `approve_pool_signs_approve_of_exactly_daily_cap_to_aave_pool` T:1306, `approve_pool_is_rate_limited` T:1339 | pending |
| R3 | Paused, zero, over `max_per_rescue`, over the daily cap, inside the cooldown, fee or gas above the caps: rejected. | `limits.rs` `check_rescue`, `check_tx_params` | `paused_contract_rejects_rescue` T:936, `zero_amount_rejected` T:956, `agent_cannot_exceed_max_per_rescue` T:963, `agent_cannot_exceed_daily_cap` T:977, `agent_cannot_rescue_during_cooldown` T:1008, `fee_above_cap_rejected` T:1036, `gas_limit_above_cap_rejected` T:1050 | — |
| R4 | Cooldown can never be zero, so a stolen agent key cannot spam rescues. | `lib.rs:384` | `set_limits_rejects_zero_cooldown_so_a_stolen_agent_key_cannot_spam_rescues` T:674 | — |
| R5 | The budget is reserved before the MPC call; a second rescue in flight is rejected; a failed signature rolls it back. | `lib.rs:615`, `lib.rs:705` | `second_rescue_while_first_in_flight_is_rejected` T:1027, `failed_signature_rolls_back_spent` T:1168 | — |
| R6 | The MPC signature must recover to the policy's Base address; high-s is normalised; a signature cannot be delivered twice. | `lib.rs:705` `on_signed`, `evm.rs:207` | `signature_from_wrong_key_is_rejected_and_budget_stays_spent` T:1209, `high_s_signature_is_normalized_to_low_s` T:1449, `signature_cannot_be_delivered_twice` T:1289 | — |
| R7 | The sign request uses `payload_v2`, the policy's path and domain 0. | `lib.rs` sign path | `rescue_calls_mpc_sign_with_payload_v2_path_and_domain` T:1068 | — |

## Agent (`apps/agent`)

| # | Claim | Code | Test | Tx |
| --- | --- | --- | --- | --- |
| G1 | The agent re-checks every signed tx (kind, to, data, nonce, hash, signer) before broadcasting. | `apps/agent/src/checks.ts` `verifySignedTx` | `apps/agent/test/checks.test.ts:84-110`, `rescue.test.ts` "never broadcast" cases | — |
| G2 | The agent refuses a policy whose config differs from the registry or whose address differs from either derivation. | `checks.ts` `assertConfigMatches` | `checks.test.ts:26`, `:30`, `:34` | — |
| G3 | A bridge still in flight is resumed, not quoted again; a 1Click outage still repays with what is on Base. | `apps/agent/src/rescue.ts` `ensureFunds`, `live` | `rescue.test.ts` "resumes a non-terminal bridge", partial-repay cases | — |
| G4 | A failed broadcast is retried; a signed repay stays resumable; a signed approve is re-sent (review F8). | `rescue.ts` `broadcastOrFind`, `resumeSignedRepay`, `rebroadcastPendingApprove` | `rescue.test.ts` "(F8)" cases | — |
| G5 | `pnpm demo --dry-run` sends nothing. | `rescue.ts` `dryRun` | `rescue.test.ts` "dry run sends nothing" | — |

## Factory-less vault creation (code written and unit-tested locally; not deployed)

The earlier `contracts/factory` design was dropped and never deployed. Tests are vitest names; no line numbers.

| # | Claim | Code | Test | Tx |
| --- | --- | --- | --- | --- |
| V1 | The deploy is one transaction on the vault account: DeployContract, `new`, `activate`, DeleteKey of the deploy key; it never adds a key or transfers. | `apps/agent/src/vault-creator.ts` `vaultDeployActions` | `apps/agent/test/vault-creator.test.ts`: `deploys_in_one_transaction_code_new_activate_then_deletes_the_deploy_key`, `never_adds_a_key_or_transfers_in_the_deploy_transaction` | pending |
| V2 | The name is `bkst-` + 20 hex of sha256 over (owner, chain, borrower, limits, salt); any changed field changes it, and a request that does not match its name is never deployed or refunded. | `packages/core/src/vault-name.ts` `vaultNameFor`, `matchesCommitment` | `packages/core/test/vault-name.test.ts`: `any_changed_field_changes_the_name`, `matchesCommitment_is_false_for_a_wrong_id_or_bad_fields`; `vault-creator.test.ts`: `fields_that_do_not_match_the_vault_name_are_never_deployed_or_refunded` | pending |
| V3 | The bot touches only an account whose keys are exactly the deploy key; any other key or code is left alone. | `vault-creator.ts` `processOne` | `an_account_with_any_other_key_is_not_touched`, `a_keyless_account_with_other_code_is_failed_not_admitted` | pending |
| V4 | Failed deploys are retried; after 3 the bot deletes the account with the owner as beneficiary, only while the deploy key is on it. An underfunded account is refunded the same way. | `vault-creator.ts` `recordFailure`, `giveUp`, `vaultAbortActions` | `retries_failures_and_after_three_aborts_with_a_refund_to_the_owner`, `an_underfunded_account_is_deleted_and_its_near_returned_to_the_owner` | pending |
| V5 | The bot refuses a wasm whose sha256 is not `POLICY_CODE_HASH`, a deploy key that does not match the site's public key, and starts no creation without a key. | `vault-creator.ts` `creatorConfig` | `refuses_a_wasm_that_is_not_the_published_code`, `refuses_a_deploy_key_that_does_not_match_the_public_key_the_site_shows`, `is_off_without_a_deploy_key` | — |
| V6 | Bad limits and non-checksummed loan addresses are refused before any deploy. | `vault-creator.ts` `requestPlan`, `limitsProblem` | `refuses_bad_limits_and_unchecksummed_loan_addresses_before_any_deploy` | — |
| V7 | The bot discovers created vaults from the database and the service refuses to start without `POLICY_CODE_HASH` (or a factory id). | `apps/agent/src/service.ts`, `discover.ts` | `discovers_ready_created_vaults_next_to_operator_vaults_with_no_factory`, `the_service_refuses_to_start_without_a_factory_or_policy_code_hash` | — |
| V8 | A vault accepts `rescue` and `fund_bridge` only from its agent, so the bot reaches a vault only through those methods. | `contracts/policy/src/lib.rs` `rescue`, `fund_bridge` | `only_agent_can_call_rescue` T:912, `owner_cannot_call_rescue_unless_agent` T:920, `only_agent_can_fund_bridge` T:1642 | — |
| V9 | The API stores a request only if its fields hash to the vault name (`apps/web/app/api/vaults/`, `apps/web/lib/vault-api.ts`, `packages/db/src/vault-requests.ts`). | listed paths | store tests in `packages/db/test/vault-requests.test.ts` (API route tests not verified here) | — |
| V10 | A self-serve vault is created, funded and closed on mainnet, with the deposit returned less the deploy gas (estimated 0.01-0.03 NEAR). | manual (rehearsal) | pending | pending |

## Fund from any chain (`apps/web/lib/fund`, design E.9)

| # | Claim | Code | Test (`apps/web/tests/fund-quote.test.ts`) | Tx |
| --- | --- | --- | --- | --- |
| F1 | The client cannot choose recipient, destination asset, swap type or refund type. | `apps/web/lib/fund/shared.ts`, `handler.ts` | L52, L59 | — |
| F2 | A tampered or mismatched signed quote yields 502 and no deposit address. | `handler.ts` | L76, L86 | — |
| F3 | A policy that fails verification or is not registered on NEAR USDC is refused before any quote. | `handler.ts` | L97, L104 | — |
| F4 | The browser re-verifies the signature (WebCrypto Ed25519) and the routing fields. | `apps/web/lib/fund/client.ts` | L155 | — |
| F5 | A deposit from another chain credits the policy on NEAR. | 1Click delivery (U12) | manual | pending |
