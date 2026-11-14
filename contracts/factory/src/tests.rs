//! Unit tests. Each test is named after the claim it proves (design K.4).

use super::*;
use near_sdk::mock::MockAction;
use near_sdk::serde_json;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{test_vm_config, testing_env, PromiseResult, RuntimeFeesConfig};

const LIB_RS: &str = include_str!("lib.rs");

const BASE_POOL: &str = "0xa238dd80c259a72e81d7e4664a9801593f98d1c5";
const BASE_USDC: &str = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const ARB_POOL: &str = "0x794a61358d6845594f94dc1db02a252b5b4814ad";
const ARB_USDC: &str = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const BASE_ASSET: &str = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const ARB_ASSET: &str = "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";
const USDC_NEAR: &str = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const ONE_CLICK_PK: &str = "ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc";
const BORROWER: &str = "0x1111222233334444555566667777888899990000";
const INIT_HEIGHT: u64 = 184_023_117;
const ZERO: NearToken = NearToken::from_yoctonear(0);

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn factory_id() -> AccountId {
    acc("vaults.backstop.near")
}
fn alice() -> AccountId {
    acc("alice.near")
}
fn bob() -> AccountId {
    acc("bob.near")
}
fn deployer() -> AccountId {
    acc("backstop.near")
}

fn config() -> FactoryConfig {
    FactoryConfig {
        chains: vec![
            ChainConfig {
                key: "base".into(),
                chain_id: 8453,
                aave_pool: BASE_POOL.into(),
                usdc: BASE_USDC.into(),
                bridge_dest_asset: BASE_ASSET.into(),
            },
            ChainConfig {
                key: "arbitrum".into(),
                chain_id: 42161,
                aave_pool: ARB_POOL.into(),
                usdc: ARB_USDC.into(),
                bridge_dest_asset: ARB_ASSET.into(),
            },
        ],
        usdc_near: acc(USDC_NEAR),
        bridge_signer_pk: ONE_CLICK_PK.into(),
        mpc_contract: acc("v1.signer"),
        derivation_path: "backstop-base-1".into(),
        default_agent: acc("agent.backstop.near"),
        fee_account: acc("fees.backstop.near"),
        fee_bps: 10,
    }
}

fn limits() -> Limits {
    Limits {
        trigger_hf_bps: 11_000,
        target_hf_bps: 13_000,
        max_per_rescue: U128(5_000_000),
        daily_cap: U128(10_000_000),
        cooldown_secs: 600,
        max_fee_per_gas: U128(1_000_000_000),
        max_gas_limit: U128(400_000),
    }
}

fn builder(predecessor: AccountId, deposit: NearToken) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(factory_id())
        .predecessor_account_id(predecessor)
        .block_height(INIT_HEIGHT)
        .account_balance(NearToken::from_near(100))
        .storage_usage(100_000)
        .attached_deposit(deposit)
        .prepaid_gas(Gas::from_tgas(300));
    b
}

fn new_factory() -> Factory {
    testing_env!(builder(deployer(), ZERO).build());
    Factory::new(config())
}

fn min_dep(f: &Factory) -> NearToken {
    NearToken::from_yoctonear(f.min_deposit().0)
}

fn create_as(f: &mut Factory, who: AccountId, chain: &str) {
    let deposit = min_dep(f);
    testing_env!(builder(who, deposit).build());
    let _ = f.create_policy(chain.into(), BORROWER.into(), limits());
}

/// Runs a private callback as the factory with one promise result.
fn as_callback(result: PromiseResult, balance: NearToken) {
    testing_env!(
        builder(factory_id(), ZERO).account_balance(balance).build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
}

fn panic_message(f: impl FnOnce()) -> String {
    let err = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).expect_err("expected a panic");
    let raw = err
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default();
    match (raw.find("panic_msg: \""), raw.rfind("\" })")) {
        (Some(start), Some(end)) if start + 12 <= end => raw[start + 12..end].to_string(),
        _ => raw,
    }
}

fn call_of(action: &MockAction) -> (String, Value, NearToken, Gas) {
    match action {
        MockAction::FunctionCallWeight { method_name, args, attached_deposit, prepaid_gas, .. } => (
            String::from_utf8(method_name.clone()).unwrap(),
            serde_json::from_slice(args).unwrap_or(Value::Null),
            *attached_deposit,
            *prepaid_gas,
        ),
        other => panic!("unexpected action {other:?}"),
    }
}

fn event(log: &str) -> Value {
    serde_json::from_str(log.strip_prefix("EVENT_JSON:").expect("not an event")).unwrap()
}

fn created(f: &mut Factory, owner: AccountId, id: &str, chain: &str) -> PromiseOrValue<AccountId> {
    as_callback(PromiseResult::Successful(vec![]), NearToken::from_near(100));
    f.on_policy_created(owner, acc(id), chain.into(), BORROWER.into(), f.min_deposit())
}

const FIRST: &str = "base-184023117.vaults.backstop.near";

// ------------------------------------------------------------------ create batch

#[test]
fn create_batch_is_create_transfer_deploy_new_with_no_add_key() {
    let mut f = new_factory();
    create_as(&mut f, alice(), "base");
    let receipts = get_created_receipts();
    assert_eq!(receipts.len(), 2, "the batch and the callback");
    let batch = &receipts[0];
    assert_eq!(batch.receiver_id, acc(FIRST));
    assert_eq!(batch.actions.len(), 4);
    assert!(matches!(batch.actions[0], MockAction::CreateAccount { .. }));
    let expected_transfer = f.min_deposit().0 - FT_STORAGE_DEPOSIT.as_yoctonear() - INDEX_FEE.as_yoctonear();
    assert!(matches!(batch.actions[1], MockAction::Transfer { deposit, .. } if deposit.as_yoctonear() == expected_transfer));
    match &batch.actions[2] {
        MockAction::DeployContract { code, .. } => assert!(code.as_slice() == POLICY_WASM, "deploys exactly POLICY_WASM"),
        other => panic!("expected DeployContract, got {other:?}"),
    }
    let (method, _, deposit, gas) = call_of(&batch.actions[3]);
    assert_eq!((method.as_str(), deposit, gas), ("new", ZERO, NEW_GAS));
    for r in &receipts {
        for a in &r.actions {
            assert!(
                !matches!(a, MockAction::AddKeyWithFullAccess { .. } | MockAction::AddKeyWithFunctionCall { .. }),
                "no AddKey in any receipt"
            );
        }
    }
    assert_eq!(receipts[1].receiver_id, factory_id());
    let (method, args, _, gas) = call_of(&receipts[1].actions[0]);
    assert_eq!(method, "on_policy_created");
    assert!(gas >= CREATE_CALLBACK_GAS);
    assert_eq!(args["owner"], "alice.near");
    assert_eq!(args["policy_id"], FIRST);
    assert_eq!(args["attached"], f.min_deposit().0.to_string());
}

#[test]
fn new_args_take_owner_from_predecessor_agent_and_fee_from_config() {
    let mut f = new_factory();
    create_as(&mut f, alice(), "arbitrum");
    let (_, args, _, _) = call_of(&get_created_receipts()[0].actions[3]);
    assert_eq!(
        args,
        json!({
            "owner": "alice.near",
            "agent": "agent.backstop.near",
            "on_behalf_of": BORROWER,
            "chain_id": 42161,
            "aave_pool": ARB_POOL,
            "usdc_base": ARB_USDC,
            "usdc_near": USDC_NEAR,
            "bridge_dest_asset": ARB_ASSET,
            "bridge_signer_pk": ONE_CLICK_PK,
            "mpc_contract": "v1.signer",
            "derivation_path": "backstop-base-1",
            "limits": serde_json::to_value(limits()).unwrap(),
            "fee_account": "fees.backstop.near",
            "fee_bps": 10,
        })
    );
}

#[test]
fn create_policy_has_no_owner_agent_or_name_argument() {
    let start = LIB_RS.find("pub fn create_policy(").expect("create_policy exists");
    let sig = &LIB_RS[start..start + LIB_RS[start..].find(')').unwrap()];
    assert_eq!(sig, "pub fn create_policy(&mut self, chain: String, on_behalf_of: String, limits: Limits");
    for word in ["owner", "agent", "name", "fee"] {
        assert!(!sig.contains(word), "create_policy takes no {word} argument");
    }
}

// ------------------------------------------------------------------ names

#[test]
fn names_come_from_a_counter_so_they_cannot_be_front_run_or_reused() {
    let mut f = new_factory();
    create_as(&mut f, alice(), "base");
    assert_eq!(get_created_receipts()[0].receiver_id, acc(FIRST));
    // A different caller cannot get the same name; neither can the same caller on another chain.
    create_as(&mut f, bob(), "base");
    assert_eq!(get_created_receipts()[0].receiver_id, acc("base-184023118.vaults.backstop.near"));
    create_as(&mut f, alice(), "arbitrum");
    assert_eq!(get_created_receipts()[0].receiver_id, acc("arbitrum-184023119.vaults.backstop.near"));
    // A failed create does not give its name back.
    as_callback(PromiseResult::Failed, NearToken::from_near(100));
    let _ = f.on_policy_created(alice(), acc(FIRST), "base".into(), BORROWER.into(), f.min_deposit());
    testing_env!(builder(alice(), ZERO).build());
    assert_eq!(f.next_policy_id("base".into()), acc("base-184023120.vaults.backstop.near"));
    assert!(!LIB_RS.contains("next_index -= 1") && !LIB_RS.contains("next_index = self.next_index -"));
}

#[test]
fn index_is_seeded_with_the_init_block_height() {
    let f = new_factory();
    assert_eq!(f.next_policy_id("base".into()), acc(FIRST));
    assert_eq!(f.next_policy_id("arbitrum".into()), acc("arbitrum-184023117.vaults.backstop.near"));
}

#[test]
fn any_owner_account_length_gives_a_valid_policy_id() {
    let mut f = new_factory();
    let hex_implicit = acc(&"ab".repeat(32));
    let eth_implicit = acc("0x1111222233334444555566667777888899990000");
    for owner in [hex_implicit, eth_implicit] {
        create_as(&mut f, owner.clone(), "base");
        let receipts = get_created_receipts();
        assert!(receipts[0].receiver_id.as_str().starts_with("base-"));
        assert!(receipts[0].receiver_id.as_str().ends_with(".vaults.backstop.near"));
        let (_, args, _, _) = call_of(&receipts[0].actions[3]);
        assert_eq!(args["owner"], owner.as_str());
    }
    // Longest possible name: a 34-char factory, the longest key and the largest index still fit 64.
    let long_factory = acc(&format!("{}.near", "v".repeat(29)));
    assert_eq!(long_factory.as_str().len(), 34);
    let mut b = builder(deployer(), ZERO);
    b.current_account_id(long_factory.clone()).block_height(u64::MAX);
    testing_env!(b.build());
    let f = Factory::new(config());
    let id = f.next_policy_id("arbitrum".into());
    assert_eq!(id.as_str().len(), 64);
    assert_eq!(id.as_str(), format!("arbitrum-{}.{long_factory}", u64::MAX));
}

#[test]
fn factory_id_too_long_is_rejected_at_init() {
    let mut b = builder(deployer(), ZERO);
    b.current_account_id(acc(&format!("{}.near", "v".repeat(30))));
    testing_env!(b.build());
    let msg = panic_message(|| {
        Factory::new(config());
    });
    assert!(msg.starts_with("ERR_FACTORY_ID_TOO_LONG"), "{msg}");
}

// ------------------------------------------------------------------ deposit and gas

#[test]
fn deposit_below_min_deposit_is_rejected_before_any_promise() {
    let mut f = new_factory();
    let min = f.min_deposit().0;
    testing_env!(builder(alice(), NearToken::from_yoctonear(min - 1)).build());
    let msg = panic_message(|| {
        let _ = f.create_policy("base".into(), BORROWER.into(), limits());
    });
    assert_eq!(msg, format!("ERR_DEPOSIT_TOO_LOW: attach at least {min} yoctoNEAR"));
    assert!(get_created_receipts().is_empty());
    assert_eq!(f.next_policy_id("base".into()), acc(FIRST), "counter untouched");
}

#[test]
fn min_deposit_covers_code_state_spare_usdc_registration_and_index() {
    let f = new_factory();
    let code = env::storage_byte_cost().as_yoctonear() * POLICY_WASM.len() as u128;
    let parts = [POLICY_STATE_MARGIN, POLICY_SPARE, FT_STORAGE_DEPOSIT, INDEX_FEE].map(|t| t.as_yoctonear());
    assert_eq!(f.min_deposit().0, code + parts.iter().sum::<u128>());
    // At the minimum the vault receives its code stake plus the margin and spare, nothing less.
    let transfer = f.min_deposit().0 - FT_STORAGE_DEPOSIT.as_yoctonear() - INDEX_FEE.as_yoctonear();
    assert_eq!(transfer, code + POLICY_STATE_MARGIN.as_yoctonear() + POLICY_SPARE.as_yoctonear());
    // Mainnet: 1e19 yocto per byte.
    let mainnet = 10_000_000_000_000_000_000u128 * POLICY_WASM.len() as u128 + parts.iter().sum::<u128>();
    assert!(mainnet > NearToken::from_near(2).as_yoctonear() && mainnet < NearToken::from_near(4).as_yoctonear());
}

#[test]
fn not_enough_gas_is_rejected() {
    let mut f = new_factory();
    let deposit = min_dep(&f);
    testing_env!(builder(alice(), deposit).prepaid_gas(Gas::from_tgas(249)).build());
    let msg = panic_message(|| {
        let _ = f.create_policy("base".into(), BORROWER.into(), limits());
    });
    assert_eq!(msg, "ERR_NOT_ENOUGH_GAS: attach 300 TGas to create_policy");
    assert!(get_created_receipts().is_empty());
}

#[test]
fn unknown_chain_is_rejected() {
    let mut f = new_factory();
    let deposit = min_dep(&f);
    testing_env!(builder(alice(), deposit).build());
    let msg = panic_message(|| {
        let _ = f.create_policy("optimism".into(), BORROWER.into(), limits());
    });
    assert_eq!(msg, "ERR_UNKNOWN_CHAIN: this factory creates vaults for base, arbitrum");
    assert!(get_created_receipts().is_empty());
}

#[test]
fn bad_on_behalf_of_is_rejected_with_the_policys_codes() {
    let mut f = new_factory();
    let deposit = min_dep(&f);
    for (input, code) in [
        ("1111222233334444555566667777888899990000", "ERR_EVM_ADDRESS_MISSING_0X"),
        ("0x1234", "ERR_EVM_ADDRESS_LENGTH"),
        ("0xzz11222233334444555566667777888899990000", "ERR_EVM_ADDRESS_NOT_HEX"),
        ("0x0000000000000000000000000000000000000000", "ERR_EVM_ADDRESS_ZERO"),
    ] {
        testing_env!(builder(alice(), deposit).build());
        let msg = panic_message(|| {
            let _ = f.create_policy("base".into(), input.into(), limits());
        });
        assert_eq!(msg, format!("{code}: on_behalf_of"));
        assert!(get_created_receipts().is_empty());
    }
    // Same codes, in the same order, as the policy's own parser.
    let policy_evm = include_str!("../../policy/src/evm.rs");
    for code in ["ERR_EVM_ADDRESS_MISSING_0X", "ERR_EVM_ADDRESS_LENGTH", "ERR_EVM_ADDRESS_NOT_HEX", "ERR_EVM_ADDRESS_ZERO"] {
        assert!(policy_evm.contains(code), "policy uses {code}");
    }
    // Mixed case is accepted and normalised.
    assert_eq!(check_evm_address("0xAbCd000000000000000000000000000000000001").unwrap(), "0xabcd000000000000000000000000000000000001");
}

// ------------------------------------------------------------------ limits

#[test]
fn factory_limits_check_is_the_policys_own_source_file() {
    assert!(LIB_RS.contains("#[path = \"../../policy/src/limits.rs\"]\nmod limits;"));
    assert!(include_str!("../../policy/src/limits.rs").contains("pub fn validate(&self)"));
}

fn create_with_limits(l: Limits) -> String {
    let mut f = new_factory();
    let deposit = min_dep(&f);
    testing_env!(builder(alice(), deposit).build());
    let msg = panic_message(|| {
        let _ = f.create_policy("base".into(), BORROWER.into(), l);
    });
    assert!(get_created_receipts().is_empty());
    msg
}

#[test]
fn target_hf_not_above_trigger_is_rejected() {
    assert_eq!(create_with_limits(Limits { target_hf_bps: 11_000, ..limits() }), "ERR_TARGET_HF_NOT_ABOVE_TRIGGER");
}

#[test]
fn max_per_rescue_zero_is_rejected() {
    assert_eq!(create_with_limits(Limits { max_per_rescue: U128(0), ..limits() }), "ERR_MAX_PER_RESCUE_ZERO");
}

#[test]
fn max_per_rescue_above_daily_cap_is_rejected() {
    assert_eq!(
        create_with_limits(Limits { max_per_rescue: U128(10_000_001), ..limits() }),
        "ERR_MAX_PER_RESCUE_ABOVE_DAILY_CAP"
    );
}

#[test]
fn max_fee_per_gas_zero_is_rejected() {
    assert_eq!(create_with_limits(Limits { max_fee_per_gas: U128(0), ..limits() }), "ERR_MAX_FEE_PER_GAS_ZERO");
}

#[test]
fn max_gas_limit_zero_is_rejected() {
    assert_eq!(create_with_limits(Limits { max_gas_limit: U128(0), ..limits() }), "ERR_MAX_GAS_LIMIT_ZERO");
}

#[test]
fn cooldown_zero_is_rejected() {
    assert_eq!(create_with_limits(Limits { cooldown_secs: 0, ..limits() }), "ERR_COOLDOWN_ZERO");
}

#[test]
fn too_many_vaults_per_owner_is_rejected() {
    let mut f = new_factory();
    for i in 0..MAX_VAULTS_PER_OWNER {
        let _ = created(&mut f, alice(), &format!("base-{i}.vaults.backstop.near"), "base");
    }
    let deposit = min_dep(&f);
    testing_env!(builder(alice(), deposit).build());
    let msg = panic_message(|| {
        let _ = f.create_policy("base".into(), BORROWER.into(), limits());
    });
    assert!(msg.starts_with("ERR_TOO_MANY_VAULTS"), "{msg}");
    assert!(get_created_receipts().is_empty());
    create_as(&mut f, bob(), "base");
    assert_eq!(get_created_receipts().len(), 2, "another owner is not affected");
}

// ------------------------------------------------------------------ callbacks

#[test]
fn successful_create_schedules_activate_and_usdc_registration() {
    let mut f = new_factory();
    let out = created(&mut f, alice(), FIRST, "base");
    assert!(matches!(out, PromiseOrValue::Value(ref id) if id == &acc(FIRST)));
    let receipts = get_created_receipts();
    assert_eq!(receipts.len(), 2);
    assert_eq!(receipts[0].receiver_id, acc(FIRST));
    let (method, args, deposit, gas) = call_of(&receipts[0].actions[0]);
    assert_eq!((method.as_str(), args, deposit, gas), ("activate", json!({}), ZERO, ACTIVATE_GAS));
    assert_eq!(receipts[1].receiver_id, acc(USDC_NEAR));
    let (method, args, deposit, gas) = call_of(&receipts[1].actions[0]);
    assert_eq!(method, "storage_deposit");
    assert_eq!(args, json!({ "account_id": FIRST, "registration_only": true }));
    assert_eq!((deposit, gas), (FT_STORAGE_DEPOSIT, FT_STORAGE_GAS));
    let e = event(&get_logs()[0]);
    assert_eq!(e["standard"], "backstop");
    assert_eq!(e["version"], "2.0.0");
    assert_eq!(e["event"], "policy_created");
    assert_eq!(e["data"][0], json!({ "owner": "alice.near", "policy": FIRST, "chain": "base", "on_behalf_of": BORROWER }));
}

#[test]
fn index_is_written_only_by_the_private_callback_on_success() {
    let mut f = new_factory();
    create_as(&mut f, alice(), "base");
    assert!(f.get_policies(alice()).is_empty(), "create_policy itself writes no index");
    assert_eq!(f.policy_count(), U64(0));
    as_callback(PromiseResult::Failed, NearToken::from_near(100));
    let _ = f.on_policy_created(alice(), acc(FIRST), "base".into(), BORROWER.into(), f.min_deposit());
    assert!(f.get_policies(alice()).is_empty(), "a failed create is not indexed");
    assert_eq!(f.policy_count(), U64(0));
    let _ = created(&mut f, alice(), FIRST, "base");
    assert_eq!(f.get_policies(alice()), vec![acc(FIRST)]);
    assert_eq!(f.policy_count(), U64(1));
    assert_eq!(
        f.list_policies(None, None),
        vec![PolicyEntry { policy: acc(FIRST), owner: alice(), chain: "base".into() }]
    );
    // The index writes appear only inside on_policy_created.
    let cb = LIB_RS.find("pub fn on_policy_created(").unwrap();
    let cb_end = LIB_RS.find("pub fn fail_create(").unwrap();
    for write in ["self.by_owner.insert(", "self.all.push("] {
        assert_eq!(LIB_RS.matches(write).count(), 1, "{write} once");
        let at = LIB_RS.find(write).unwrap();
        assert!(at > cb && at < cb_end, "{write} only in on_policy_created");
    }
}

/// `#[private]` is enforced by the exported wasm wrapper (unit tests call the Rust method
/// directly), so this checks the attribute on every callback, and that nothing else is private.
#[test]
fn callbacks_are_private() {
    for method in ["on_policy_created", "fail_create"] {
        let at = LIB_RS.find(&format!("pub fn {method}(")).unwrap();
        let attrs = &LIB_RS[LIB_RS[..at].rfind("\n\n").unwrap()..at];
        assert!(attrs.contains("    #[private]\n"), "{method} must be #[private]");
    }
    assert_eq!(LIB_RS.matches("#[private]").count(), 2);
    for method in ["create_policy", "claim_refund", "new"] {
        let at = LIB_RS.find(&format!("pub fn {method}(")).unwrap();
        let attrs = &LIB_RS[LIB_RS[..at].rfind("\n\n").unwrap()..at];
        assert!(!attrs.contains("#[private]"), "{method} is public");
    }
}

#[test]
fn failed_create_refunds_the_whole_deposit_to_the_caller_and_fails_visibly() {
    let mut f = new_factory();
    let attached = f.min_deposit();
    as_callback(PromiseResult::Failed, NearToken::from_near(100));
    let out = f.on_policy_created(alice(), acc(FIRST), "base".into(), BORROWER.into(), attached);
    assert!(matches!(out, PromiseOrValue::Promise(_)));
    drop(out);
    let receipts = get_created_receipts();
    assert_eq!(receipts[0].receiver_id, alice());
    assert!(matches!(receipts[0].actions[0], MockAction::Transfer { deposit, .. } if deposit.as_yoctonear() == attached.0));
    assert_eq!(receipts[1].receiver_id, factory_id());
    let (method, args, _, _) = call_of(&receipts[1].actions[0]);
    assert_eq!(method, "fail_create");
    assert_eq!(args, json!({ "policy_id": FIRST, "refund_pending": false }));
    assert_eq!(f.get_refund(alice()), U128(0));
    as_callback(PromiseResult::Successful(vec![]), NearToken::from_near(100));
    let msg = panic_message(|| f.fail_create(acc(FIRST), false));
    assert_eq!(msg, format!("ERR_CREATE_FAILED: {FIRST} was not created; your deposit was refunded"));
}

#[test]
fn failed_create_without_liquidity_records_a_refund_only_the_owner_can_claim_once() {
    let mut f = new_factory();
    let attached = f.min_deposit();
    // The runtime's refund of the batch has not arrived yet: the factory holds only 1 NEAR.
    as_callback(PromiseResult::Failed, NearToken::from_near(1));
    let out = f.on_policy_created(alice(), acc(FIRST), "base".into(), BORROWER.into(), attached);
    drop(out);
    let receipts = get_created_receipts();
    assert_eq!(receipts.len(), 1, "no transfer, only fail_create");
    let (method, args, _, _) = call_of(&receipts[0].actions[0]);
    assert_eq!(method, "fail_create");
    assert_eq!(args["refund_pending"], true);
    assert_eq!(f.get_refund(alice()), attached);
    let e = event(&get_logs()[0]);
    assert_eq!(e["event"], "refund_pending");
    assert_eq!(e["data"][0], json!({ "owner": "alice.near", "amount": attached.0.to_string() }));
    as_callback(PromiseResult::Successful(vec![]), NearToken::from_near(1));
    let msg = panic_message(|| f.fail_create(acc(FIRST), true));
    assert_eq!(msg, format!("ERR_CREATE_FAILED: {FIRST} was not created; call claim_refund"));

    testing_env!(builder(bob(), ZERO).build());
    assert!(panic_message(|| {
        f.claim_refund();
    })
    .starts_with("ERR_NO_REFUND"));
    testing_env!(builder(alice(), ZERO).build());
    assert_eq!(f.claim_refund(), attached);
    let receipts = get_created_receipts();
    assert_eq!(receipts[0].receiver_id, alice());
    assert!(matches!(receipts[0].actions[0], MockAction::Transfer { deposit, .. } if deposit.as_yoctonear() == attached.0));
    assert_eq!(event(&get_logs()[0])["event"], "refund_claimed");
    assert_eq!(f.get_refund(alice()), U128(0));
    testing_env!(builder(alice(), ZERO).build());
    assert!(panic_message(|| {
        f.claim_refund();
    })
    .starts_with("ERR_NO_REFUND"));
}

#[test]
fn recorded_refunds_are_not_spent_on_later_refunds() {
    let mut f = new_factory();
    let attached = f.min_deposit();
    as_callback(PromiseResult::Failed, NearToken::from_near(1));
    let _ = f.on_policy_created(alice(), acc(FIRST), "base".into(), BORROWER.into(), attached);
    // 4 NEAR now covers one more refund on its own, but not while alice's 2.9 NEAR is owed.
    as_callback(PromiseResult::Failed, NearToken::from_near(4));
    let _ = f.on_policy_created(bob(), acc("base-2.vaults.backstop.near"), "base".into(), BORROWER.into(), attached);
    assert_eq!(f.get_refund(bob()), attached);
}

// ------------------------------------------------------------------ immutability and init

#[test]
fn factory_has_no_setters_no_add_key_and_deploys_only_the_embedded_wasm() {
    assert!(!LIB_RS.contains("fn set_"), "no setters");
    for key in ["add_full_access_key", "add_access_key", "delete_key", "delete_account", "deploy_global"] {
        assert!(!LIB_RS.contains(key), "no {key}");
    }
    assert_eq!(LIB_RS.matches(".deploy_contract(").count(), 1);
    assert_eq!(LIB_RS.matches(".deploy_contract(POLICY_WASM)").count(), 1);
    assert_eq!(LIB_RS.matches("include_bytes!(").count(), 1);
    assert!(LIB_RS.contains("include_bytes!(\"../../policy/target/near/backstop_policy.wasm\")"));
}

#[test]
fn new_can_be_called_only_once() {
    let _f = new_factory();
    // near-sdk's #[init] refuses to run when state exists.
    let src = LIB_RS.find("#[init]\n    pub fn new(").expect("new is #[init] without ignore_state");
    assert!(src > 0 && !LIB_RS.contains("ignore_state"));
}

fn init_error(mutate: impl FnOnce(&mut FactoryConfig)) -> String {
    let mut c = config();
    mutate(&mut c);
    testing_env!(builder(deployer(), ZERO).build());
    panic_message(|| {
        Factory::new(c);
    })
}

#[test]
fn fee_bps_above_cap_is_rejected_at_init() {
    assert!(init_error(|c| c.fee_bps = 51).starts_with("ERR_FEE_ABOVE_CAP_BPS"));
    testing_env!(builder(deployer(), ZERO).build());
    let mut c = config();
    c.fee_bps = MAX_FEE_BPS;
    assert_eq!(Factory::new(c).get_config().fee_bps, 50);
}

#[test]
fn fee_account_cannot_be_the_factory() {
    assert!(init_error(|c| c.fee_account = factory_id()).starts_with("ERR_FEE_ACCOUNT_IS_FACTORY"));
}

#[test]
fn duplicate_chain_is_rejected_at_init() {
    assert!(init_error(|c| c.chains[1].key = "base".into()).starts_with("ERR_DUPLICATE_CHAIN"));
    assert!(init_error(|c| c.chains[1].chain_id = 8453).starts_with("ERR_DUPLICATE_CHAIN"));
}

#[test]
fn bad_chain_config_is_rejected_at_init() {
    assert!(init_error(|c| c.chains.clear()).starts_with("ERR_NO_CHAINS"));
    assert!(init_error(|c| c.chains[0].key = "Base".into()).starts_with("ERR_CHAIN_KEY_FORMAT"));
    assert!(init_error(|c| c.chains[0].key = "base-1".into()).starts_with("ERR_CHAIN_KEY_FORMAT"));
    assert!(init_error(|c| c.chains[0].key = "abcdefghijklm".into()).starts_with("ERR_CHAIN_KEY_FORMAT"));
    assert!(init_error(|c| c.chains[0].chain_id = 0).starts_with("ERR_CHAIN_ID_ZERO"));
    assert_eq!(init_error(|c| c.chains[0].aave_pool = "0x12".into()), "ERR_EVM_ADDRESS_LENGTH: chains[0].aave_pool");
    assert_eq!(
        init_error(|c| c.chains[1].usdc = "0x0000000000000000000000000000000000000000".into()),
        "ERR_EVM_ADDRESS_ZERO: chains[1].usdc"
    );
    assert!(init_error(|c| c.chains[0].bridge_dest_asset.clear()).starts_with("ERR_CONFIG_FIELD_EMPTY"));
    assert!(init_error(|c| c.derivation_path.clear()).starts_with("ERR_CONFIG_FIELD_EMPTY"));
    assert!(init_error(|c| c.bridge_signer_pk.clear()).starts_with("ERR_CONFIG_FIELD_EMPTY"));
    assert!(init_error(|c| c.bridge_signer_pk = "ed25519:abc".into()).starts_with("ERR_BRIDGE_SIGNER_FORMAT"));
}

// ------------------------------------------------------------------ views

#[test]
fn policy_code_hash_is_sha256_of_the_embedded_wasm() {
    let f = new_factory();
    let hash = f.policy_code_hash();
    assert_eq!(hash, hex::encode(env::sha256(POLICY_WASM)));
    assert_eq!(hash.len(), 64);
    assert!(hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    assert_eq!(&POLICY_WASM[..4], b"\0asm");
}

#[test]
fn views_return_the_documented_shapes() {
    let mut f = new_factory();
    assert_eq!(f.get_config(), config());
    assert!(f.get_policies(alice()).is_empty());
    assert_eq!(f.get_refund(alice()), U128(0));
    for i in 0..3 {
        let _ = created(&mut f, if i == 1 { bob() } else { alice() }, &format!("base-{i}.vaults.backstop.near"), "base");
    }
    assert_eq!(f.get_policies(alice()), vec![acc("base-0.vaults.backstop.near"), acc("base-2.vaults.backstop.near")]);
    assert_eq!(f.list_policies(Some(1), Some(1))[0].owner, bob());
    assert_eq!(f.list_policies(Some(2), Some(1_000)).len(), 1);
    assert!(f.list_policies(Some(5), None).is_empty());
    assert!(f.list_policies(Some(u64::MAX), Some(u64::MAX)).is_empty());
    let cfg = serde_json::to_value(f.get_config()).unwrap();
    assert_eq!(cfg["fee_bps"], 10);
    assert_eq!(cfg["chains"][0]["key"], "base");
    let min = serde_json::to_value(f.min_deposit()).unwrap();
    assert!(min.is_string(), "min_deposit is a U128 string");
    assert!(panic_message(|| {
        f.next_policy_id("solana".into());
    })
    .starts_with("ERR_UNKNOWN_CHAIN"));
}
