# For judges: claim → code → test → tx

Every claim points at the code that implements it and the test that proves it. Line numbers are
the start of the function or test in this commit. Paths are relative to the repo root.

- Contract tests: `contracts/policy/src/tests.rs` (written `T:<line>` below) — `pnpm contract:test`.
- Factory tests: `contracts/factory/src/tests.rs` (written `tests.rs:<line>` in the factory section) — `pnpm factory:test`.
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

## Vault factory (`contracts/factory`, in progress; not deployed)

| # | Claim | Code | Test | Tx |
| --- | --- | --- | --- | --- |
| V1 | The factory creates each vault in one batch (CreateAccount, Transfer, DeployContract of the embedded policy wasm, `new`) and never adds an access key. It has no setters. | `contracts/factory/src/lib.rs` `create_policy` (l.222) | `create_batch_is_create_transfer_deploy_new_with_no_add_key` tests.rs:156, `factory_has_no_setters_no_add_key_and_deploys_only_the_embedded_wasm` tests.rs:581 | pending |
| V2 | The vault owner is the caller (predecessor); the agent is the factory's default agent (the bot account); `create_policy` takes no owner, agent or name argument. | `lib.rs` `new`, `create_policy` | `new_args_take_owner_from_predecessor_agent_and_fee_from_config` tests.rs:191, `create_policy_has_no_owner_agent_or_name_argument` tests.rs:217 | pending |
| V3 | Names are `<chain>-<n>.<factory>` with `n` from a counter seeded with the init block height; the caller never chooses a name and a number is never reissued. | `lib.rs` `create_policy`, `new`, `next_policy_id` | `names_come_from_a_counter_so_they_cannot_be_front_run_or_reused` tests.rs:229, `index_is_seeded_with_the_init_block_height` tests.rs:247, `any_owner_account_length_gives_a_valid_policy_id` tests.rs:254 | pending |
| V4 | A deposit below `min_deposit` (covering code, state, spare, USDC registration and the index) and a call with too little gas are rejected before any promise. | `lib.rs` `create_policy` (l.222), `min_deposit` (l.382) | `deposit_below_min_deposit_is_rejected_before_any_promise` tests.rs:292, `min_deposit_covers_code_state_spare_usdc_registration_and_index` tests.rs:305, `not_enough_gas_is_rejected` tests.rs:319 | pending |
| V5 | The chain allow-list is fixed at `new`; unknown chains, duplicate chains, bad chain config, a fee above 50 bps and a fee account that is the factory are rejected. | `lib.rs:139` `validate_config`, `lib.rs` `create_policy` | `unknown_chain_is_rejected` tests.rs:331, `fee_bps_above_cap_is_rejected_at_init` tests.rs:610, `fee_account_cannot_be_the_factory` tests.rs:619, `duplicate_chain_is_rejected_at_init` tests.rs:624, `bad_chain_config_is_rejected_at_init` tests.rs:630, `factory_id_too_long_is_rejected_at_init` tests.rs:279 | pending |
| V6 | The loan address (`on_behalf_of`) is checked with the policy's own rules; the factory's vault limits use the policy's own `limits.rs` source file. | `lib.rs:122` `check_evm_address`, `lib.rs:222` | `bad_on_behalf_of_is_rejected_with_the_policys_codes` tests.rs:343, `factory_limits_check_is_the_policys_own_source_file` tests.rs:371, `target_hf_not_above_trigger_is_rejected` tests.rs:388, `max_per_rescue_above_daily_cap_is_rejected` tests.rs:398, `cooldown_zero_is_rejected` tests.rs:416 | pending |
| V7 | An owner can hold at most 8 vaults in the index. | `lib.rs:222` | `too_many_vaults_per_owner_is_rejected` tests.rs:421 | pending |
| V8 | The index is written only by the private success callback, and the callbacks are private. Activation and the USDC storage registration run after success, not in the create batch. | `lib.rs:284` `on_policy_created`, `lib.rs:338` `fail_create` | `successful_create_schedules_activate_and_usdc_registration` tests.rs:440, `index_is_written_only_by_the_private_callback_on_success` tests.rs:462, `callbacks_are_private` tests.rs:491 | pending |
| V9 | A failed create refunds the whole deposit to the caller, or records a refund the caller can claim once; recorded refunds are not spent twice. | `lib.rs:284`, `lib.rs:344` `claim_refund` | `failed_create_refunds_the_whole_deposit_to_the_caller_and_fails_visibly` tests.rs:506, `failed_create_without_liquidity_records_a_refund_only_the_owner_can_claim_once` tests.rs:527, `recorded_refunds_are_not_spent_on_later_refunds` tests.rs:567 | pending |
| V10 | The factory's policy code hash is the SHA-256 of the embedded policy wasm; `new` rejects a second init. | `lib.rs` `policy_code_hash`, `new` | `policy_code_hash_is_sha256_of_the_embedded_wasm` tests.rs:650, `new_can_be_called_only_once` tests.rs:593 | pending |
| V11 | The views return the documented shapes (`get_policies`, `list_policies`, `get_config`, `min_deposit`, `get_refund`). | `lib.rs:358-403` | `views_return_the_documented_shapes` tests.rs:660 | — |
| V12 | A vault accepts `rescue` and `fund_bridge` only from its agent, so the bot account reaches a vault only through those methods. | `contracts/policy/src/lib.rs` `rescue`, `fund_bridge` | `only_agent_can_call_rescue` T:912, `owner_cannot_call_rescue_unless_agent` T:920, `only_agent_can_fund_bridge` T:1642 | — |
| V13 | The web refuses `create_policy` when the factory has access keys or its chains, pool, USDC, fee or bridge asset do not match the site's registry. | planned: `apps/web/lib/factory-client.ts` | pending (apps/web tests not written) | — |
| V14 | The bot admits only vaults whose agent is the bot account and whose code hash is `policy_code_hash`; others are refused and never called. | planned: `apps/agent/src/service.ts` | pending (apps/agent service tests not written) | — |
| V15 | A user-created vault on mainnet is created, funded and closed with the deposit returned less about 0.007 NEAR. | manual (rehearsal) | pending | pending |

## Fund from any chain (`apps/web/lib/fund`, design E.9)

| # | Claim | Code | Test (`apps/web/tests/fund-quote.test.ts`) | Tx |
| --- | --- | --- | --- | --- |
| F1 | The client cannot choose recipient, destination asset, swap type or refund type. | `apps/web/lib/fund/shared.ts`, `handler.ts` | L52, L59 | — |
| F2 | A tampered or mismatched signed quote yields 502 and no deposit address. | `handler.ts` | L76, L86 | — |
| F3 | A policy that fails verification or is not registered on NEAR USDC is refused before any quote. | `handler.ts` | L97, L104 | — |
| F4 | The browser re-verifies the signature (WebCrypto Ed25519) and the routing fields. | `apps/web/lib/fund/client.ts` | L155 | — |
| F5 | A deposit from another chain credits the policy on NEAR. | 1Click delivery (U12) | manual | pending |
