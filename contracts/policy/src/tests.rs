//! Unit tests. Each test is named after the safety claim it proves.

use super::*;
use crate::bridge::{check_quote, verify_quote_signature};
use crate::evm::{
    assemble_signed_tx, encode_approve, encode_repay, encode_transfer, normalize_low_s, parse_sign_response,
    APPROVE_SELECTOR, REPAY_SELECTOR, TRANSFER_SELECTOR,
};
use crate::time::parse_iso_utc;
use ed25519_dalek::Signer;
use k256::ecdsa::{RecoveryId, Signature as K256Signature, SigningKey, VerifyingKey};
use near_sdk::mock::MockAction;
use near_sdk::serde_json::Map;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{test_vm_config, testing_env, PromiseResult, RuntimeFeesConfig};

const DAY: u64 = 86_400;
/// 2025-11-12 00:00:00 UTC.
const DAY0: u64 = 20_404 * DAY;
const T0: u64 = DAY0 + 3_600;

const POOL: &str = "0xa238dd80c259a72e81d7e4664a9801593f98d1c5";
const USDC: &str = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
/// The borrower: the user's own EVM address that holds the loan.
const BORROWER: &str = "0x1111222233334444555566667777888899990000";
const USDC_NEAR: &str = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const DEST_ASSET: &str = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
/// 1Click's real quote-signing key.
const ONE_CLICK_PK: &str = "ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc";
const DEPOSIT_ADDRESS: &str = "abababababababababababababababababababababababababababababababab";

const GWEI: u128 = 1_000_000_000;
const USDC_1: u128 = 1_000_000;
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const ZERO: NearToken = NearToken::from_yoctonear(0);

fn owner() -> AccountId {
    "owner.near".parse().unwrap()
}
fn agent() -> AccountId {
    "agent.near".parse().unwrap()
}
fn stranger() -> AccountId {
    "stranger.near".parse().unwrap()
}
fn policy_account() -> AccountId {
    "policy.near".parse().unwrap()
}
fn mpc() -> AccountId {
    "v1.signer".parse().unwrap()
}
fn usdc_near() -> AccountId {
    USDC_NEAR.parse().unwrap()
}

fn builder(predecessor: AccountId, now: u64, deposit: NearToken) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(policy_account())
        .predecessor_account_id(predecessor)
        .block_timestamp(now * 1_000_000_000)
        .attached_deposit(deposit)
        .prepaid_gas(Gas::from_tgas(300));
    b
}

fn context(predecessor: AccountId, now: u64) -> near_sdk::VMContext {
    builder(predecessor, now, ZERO).build()
}

fn set_env(predecessor: AccountId, now: u64) {
    testing_env!(context(predecessor, now));
}

/// A call with exactly 1 yoctoNEAR attached: what a wallet (full-access key) sends.
fn set_env_yocto(predecessor: AccountId, now: u64) {
    testing_env!(builder(predecessor, now, ONE_YOCTO).build());
}

fn set_env_with_result(now: u64, result: PromiseResult) {
    testing_env!(
        context(policy_account(), now),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
}

/// Runs `f` and returns the contract's panic message (fails the test if it did not panic).
/// The mocked VM wraps it as `HostError(GuestPanic { panic_msg: "<msg>" })`.
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

/// The key MPC would derive for (policy.near, backstop-base-1); here a fixed test key.
fn mpc_key() -> SigningKey {
    SigningKey::from_bytes(&[7u8; 32].into()).unwrap()
}

fn uncompressed(key: &VerifyingKey) -> [u8; 64] {
    let point = key.to_encoded_point(false);
    let mut pk = [0u8; 64];
    pk.copy_from_slice(&point.as_bytes()[1..]);
    pk
}

fn eth_address(key: &VerifyingKey) -> [u8; 20] {
    evm::address_from_public_key(&uncompressed(key))
}

fn base_address() -> String {
    evm::format_evm_address(&eth_address(mpc_key().verifying_key()))
}

/// `v1.signer.derived_public_key` response for `key`.
fn derived_key_response(key: &VerifyingKey) -> Vec<u8> {
    json!(format!("secp256k1:{}", near_sdk::bs58::encode(uncompressed(key)).into_string())).to_string().into_bytes()
}

/// Test stand-in for 1Click's quote-signing key.
fn bridge_key() -> ed25519_dalek::SigningKey {
    ed25519_dalek::SigningKey::from_bytes(&[5u8; 32])
}

fn bridge_pk() -> String {
    bridge::encode_ed25519(bridge_key().verifying_key().as_bytes())
}

fn limits() -> Limits {
    Limits {
        trigger_hf_bps: 11_000,
        target_hf_bps: 13_000,
        max_per_rescue: U128(5 * USDC_1),
        daily_cap: U128(8 * USDC_1),
        cooldown_secs: 600,
        max_fee_per_gas: U128(GWEI),
        max_gas_limit: U128(400_000),
    }
}

fn fee_account() -> AccountId {
    "fees.backstop.near".parse().unwrap()
}

fn new_policy_with(on_behalf_of: &str, signer_pk: &str) -> Policy {
    new_policy_with_fee(on_behalf_of, signer_pk, 0)
}

fn new_policy_with_fee(on_behalf_of: &str, signer_pk: &str, fee_bps: u32) -> Policy {
    Policy::new(
        owner(),
        agent(),
        on_behalf_of.into(),
        8453,
        POOL.into(),
        USDC.into(),
        usdc_near(),
        DEST_ASSET.into(),
        signer_pk.into(),
        mpc(),
        "backstop-base-1".into(),
        limits(),
        fee_account(),
        fee_bps,
    )
}

fn new_unactivated_policy() -> Policy {
    set_env(policy_account(), T0);
    new_policy_with(BORROWER, &bridge_pk())
}

fn activate_with(p: &mut Policy, key: &VerifyingKey) {
    set_env_with_result(T0, PromiseResult::Successful(derived_key_response(key)));
    p.on_derived_key();
}

fn new_policy() -> Policy {
    let mut p = new_unactivated_policy();
    activate_with(&mut p, mpc_key().verifying_key());
    p
}

fn rescue_at(p: &mut Policy, now: u64, amount: u128) -> u64 {
    set_env(agent(), now);
    let _ = p.rescue(U128(amount), U64(7), U128(GWEI / 10), U128(GWEI / 100), U128(300_000));
    p.next_rescue_id - 1
}

/// Signs `hash` like v1.signer does and returns its JSON response.
fn mpc_response(key: &SigningKey, hash: &[u8; 32]) -> Vec<u8> {
    let (sig, recid) = key.sign_prehash_recoverable(hash).unwrap();
    response_json(&sig, recid)
}

fn response_json(sig: &K256Signature, recid: RecoveryId) -> Vec<u8> {
    let r: [u8; 32] = sig.r().to_bytes().into();
    let s: [u8; 32] = sig.s().to_bytes().into();
    let prefix = if recid.is_y_odd() { "03" } else { "02" };
    json!({
        "scheme": "Secp256k1",
        "big_r": { "affine_point": format!("{prefix}{}", hex::encode(r)) },
        "s": { "scalar": hex::encode(s) },
        "recovery_id": recid.to_byte(),
    })
    .to_string()
    .into_bytes()
}

fn sign_pending(p: &mut Policy, id: u64, now: u64) -> PromiseOrValue<RescueSigned> {
    let hash = p.pending.get(&id).unwrap().payload_hash;
    set_env_with_result(now, PromiseResult::Successful(mpc_response(&mpc_key(), &hash)));
    p.on_signed(id)
}

fn expect_signed(r: PromiseOrValue<RescueSigned>) -> RescueSigned {
    match r {
        PromiseOrValue::Value(v) => v,
        PromiseOrValue::Promise(_) => panic!("expected a signed rescue, got the failure path"),
    }
}

fn expect_failed<T>(r: PromiseOrValue<T>) {
    assert!(matches!(r, PromiseOrValue::Promise(_)), "expected the failure path");
}

fn event(log: &str) -> Value {
    serde_json::from_str(log.strip_prefix("EVENT_JSON:").expect("not an event")).unwrap()
}

/// Decoded fields of a signed EIP-1559 tx.
struct DecodedTx {
    chain_id: u64,
    nonce: u64,
    max_priority_fee_per_gas: u128,
    max_fee_per_gas: u128,
    gas_limit: u128,
    to: Vec<u8>,
    value: Vec<u8>,
    data: Vec<u8>,
    signer: [u8; 20],
}

fn strict_int(item: &rlp::Rlp) -> Vec<u8> {
    let data = item.data().unwrap().to_vec();
    assert!(data.first() != Some(&0), "non-canonical RLP integer (leading zero)");
    data
}

fn left_pad_32(b: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[32 - b.len()..].copy_from_slice(b);
    out
}

/// Decodes a raw signed tx and recovers the signer independently of the contract code (k256).
fn decode_signed_tx(raw: &[u8]) -> DecodedTx {
    assert_eq!(raw[0], 0x02, "not an EIP-1559 tx");
    let list = rlp::Rlp::new(&raw[1..]);
    assert_eq!(list.item_count().unwrap(), 12);
    let mut unsigned = rlp::RlpStream::new_list(9);
    for i in 0..9 {
        unsigned.append_raw(list.at(i).unwrap().as_raw(), 1);
    }
    let mut preimage = vec![0x02];
    preimage.extend_from_slice(&unsigned.out());
    let hash = env::keccak256_array(&preimage);

    let v: u8 = list.val_at(9).unwrap();
    let r = strict_int(&list.at(10).unwrap());
    let s = strict_int(&list.at(11).unwrap());
    let sig = K256Signature::from_scalars(left_pad_32(&r), left_pad_32(&s)).unwrap();
    assert!(sig.normalize_s().is_none(), "s must be low (EIP-2)");
    let key = VerifyingKey::recover_from_prehash(&hash, &sig, RecoveryId::from_byte(v).unwrap()).unwrap();

    DecodedTx {
        chain_id: list.val_at(0).unwrap(),
        nonce: list.val_at(1).unwrap(),
        max_priority_fee_per_gas: list.val_at(2).unwrap(),
        max_fee_per_gas: list.val_at(3).unwrap(),
        gas_limit: list.val_at(4).unwrap(),
        to: list.at(5).unwrap().data().unwrap().to_vec(),
        value: list.at(6).unwrap().data().unwrap().to_vec(),
        data: list.at(7).unwrap().data().unwrap().to_vec(),
        signer: eth_address(&key),
    }
}

fn hex_bytes(s: &str) -> Vec<u8> {
    hex::decode(s.strip_prefix("0x").unwrap()).unwrap()
}

/// (method, args JSON, deposit, gas) of a function-call action.
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

// ------------------------------------------------------------------ calldata

#[test]
fn repay_selector_is_keccak_of_signature() {
    set_env(policy_account(), T0);
    let h = env::keccak256_array(b"repay(address,uint256,uint256,address)");
    assert_eq!(h[..4], REPAY_SELECTOR);
    assert_eq!(hex::encode(REPAY_SELECTOR), "573ade81");
}

#[test]
fn approve_selector_is_keccak_of_signature() {
    set_env(policy_account(), T0);
    let h = env::keccak256_array(b"approve(address,uint256)");
    assert_eq!(h[..4], APPROVE_SELECTOR);
    assert_eq!(hex::encode(APPROVE_SELECTOR), "095ea7b3");
}

#[test]
fn transfer_selector_is_keccak_of_signature() {
    set_env(policy_account(), T0);
    let h = env::keccak256_array(b"transfer(address,uint256)");
    assert_eq!(h[..4], TRANSFER_SELECTOR);
    assert_eq!(hex::encode(TRANSFER_SELECTOR), "a9059cbb");
}

#[test]
fn repay_calldata_is_abi_encoded() {
    let asset = evm::parse_evm_address(USDC).unwrap();
    let who = evm::parse_evm_address(POOL).unwrap();
    let data = encode_repay(&asset, 1_234_567, &who);
    assert_eq!(data.len(), 4 + 4 * 32);
    assert_eq!(
        hex::encode(&data[4..]),
        format!("{:0>64}{:0>64}{:0>64}{:0>64}", &USDC[2..], format!("{:x}", 1_234_567u64), "2", &POOL[2..])
    );
}

#[test]
fn approve_and_transfer_calldata_are_abi_encoded() {
    let who = evm::parse_evm_address(POOL).unwrap();
    for (data, selector) in [(encode_approve(&who, 255), APPROVE_SELECTOR), (encode_transfer(&who, 255), TRANSFER_SELECTOR)] {
        assert_eq!(data[..4], selector);
        assert_eq!(hex::encode(&data[4..]), format!("{:0>64}{:0>64}", &POOL[2..], "ff"));
    }
}

// ------------------------------------------------------------------ init / activation

#[test]
#[should_panic(expected = "ERR_EVM_ADDRESS_LENGTH: on_behalf_of")]
fn new_rejects_malformed_evm_address() {
    set_env(policy_account(), T0);
    new_policy_with("0x1234", &bridge_pk());
}

#[test]
#[should_panic(expected = "ERR_EVM_ADDRESS_MISSING_0X: aave_pool")]
fn new_rejects_evm_address_without_0x() {
    set_env(policy_account(), T0);
    Policy::new(
        owner(), agent(), BORROWER.into(), 8453, POOL[2..].into(), USDC.into(), usdc_near(), DEST_ASSET.into(),
        bridge_pk(), mpc(), "p".into(), limits(), fee_account(), 0,
    );
}

#[test]
#[should_panic(expected = "ERR_EVM_ADDRESS_ZERO: on_behalf_of")]
fn new_rejects_zero_evm_address() {
    set_env(policy_account(), T0);
    new_policy_with(&format!("0x{}", "0".repeat(40)), &bridge_pk());
}

#[test]
fn new_rejects_malformed_bridge_signer() {
    for bad in ["reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc", "ed25519:", "ed25519:0OIl", "ed25519:3yZe7d", "secp256k1:abc"] {
        set_env(policy_account(), T0);
        let msg = panic_message(|| {
            new_policy_with(BORROWER, bad);
        });
        assert!(msg.starts_with("ERR_BRIDGE_SIGNER_FORMAT"), "{bad}: {msg}");
    }
}

#[test]
#[should_panic(expected = "ERR_BRIDGE_DEST_ASSET_EMPTY")]
fn new_rejects_empty_bridge_dest_asset() {
    set_env(policy_account(), T0);
    Policy::new(
        owner(), agent(), BORROWER.into(), 8453, POOL.into(), USDC.into(), usdc_near(), String::new(), bridge_pk(),
        mpc(), "p".into(), limits(), fee_account(), 0,
    );
}

/// `new` is `#[init]` without `ignore_state`, so near-sdk's generated entry point panics with
/// "The contract has already been initialized" once state exists (near-sdk-macros 5.30.1,
/// `impl_item_method_info.rs`). That wrapper only exists in the wasm build, so this test pins the
/// attribute itself; it also proves `new` is not `#[private]` (the deploy batch must call it).
#[test]
fn new_can_be_called_only_once() {
    let src = include_str!("lib.rs");
    let at = src.find("    pub fn new(").expect("new exists");
    let attrs = &src[src[..at].rfind("/// Not `#[private]`").unwrap()..at];
    assert!(attrs.contains("#[init]\n"), "new must be a plain #[init]");
    assert!(!attrs.contains("ignore_state"), "new must not ignore existing state");
    assert!(!attrs.contains("    #[private]\n"), "new must be callable by the deploy batch");
}

#[test]
fn new_sets_owner_from_argument_and_base_address_unset() {
    let p = new_unactivated_policy();
    let c = p.get_config();
    assert_eq!(c.owner, owner(), "owner is the argument, not the deployer");
    assert_eq!(c.base_address, None);
    assert_eq!(c.on_behalf_of, BORROWER);
}

#[test]
#[should_panic(expected = "ERR_NOT_ACTIVATED")]
fn rescue_before_activation_is_rejected() {
    let mut p = new_unactivated_policy();
    set_env(agent(), T0);
    let _ = p.rescue(U128(USDC_1), U64(0), U128(GWEI / 10), U128(0), U128(300_000));
}

#[test]
#[should_panic(expected = "ERR_NOT_ACTIVATED")]
fn fund_bridge_before_activation_is_rejected() {
    let mut p = new_unactivated_policy();
    set_env(agent(), T0);
    let q = quote_string(&valid_quote(T0));
    let _ = p.fund_bridge(q.clone(), sign_quote(&q));
}

#[test]
#[should_panic(expected = "ERR_NOT_ACTIVATED")]
fn approve_pool_before_activation_is_rejected() {
    let mut p = new_unactivated_policy();
    set_env(agent(), T0);
    let _ = p.approve_pool(U64(0), U128(GWEI / 10), U128(0), U128(100_000));
}

#[test]
fn activate_asks_mpc_for_the_key_derived_from_this_account_and_path() {
    let mut p = new_unactivated_policy();
    set_env(stranger(), T0);
    let _ = p.activate();
    let receipts = get_created_receipts();
    assert_eq!(receipts[0].receiver_id, mpc());
    let (method, args, deposit, gas) = call_of(&receipts[0].actions[0]);
    assert_eq!(method, "derived_public_key");
    assert_eq!(args, json!({ "path": "backstop-base-1", "predecessor": "policy.near", "domain_id": 0 }));
    assert_eq!(deposit, ZERO);
    assert_eq!(gas, DERIVE_VIEW_GAS);
    assert_eq!(receipts[1].receiver_id, policy_account());
    let (method, _, _, gas) = call_of(&receipts[1].actions[0]);
    assert_eq!(method, "on_derived_key");
    assert_eq!(gas, DERIVE_CALLBACK_GAS);
}

#[test]
fn activation_sets_base_address_from_mpc_public_key() {
    let mut p = new_unactivated_policy();
    set_env_with_result(T0, PromiseResult::Successful(derived_key_response(mpc_key().verifying_key())));
    assert_eq!(p.on_derived_key(), base_address());
    assert_eq!(p.get_config().base_address, Some(base_address()));
    let e = event(&get_logs()[0]);
    assert_eq!(e["event"], "activated");
    assert_eq!(e["data"][0]["base_address"], base_address());
}

#[test]
fn activation_with_malformed_mpc_key_is_rejected_and_can_be_retried() {
    let mut p = new_unactivated_policy();
    let bad: [Vec<u8>; 4] = [
        b"\"secp256k1:abc\"".to_vec(),
        b"\"ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc\"".to_vec(),
        b"{\"key\":1}".to_vec(),
        vec![b'"'; 300],
    ];
    for response in bad {
        set_env_with_result(T0, PromiseResult::Successful(response));
        let msg = panic_message(|| {
            p.on_derived_key();
        });
        assert!(msg.starts_with("ERR_DERIVE_FAILED"), "{msg}");
        assert_eq!(p.get_config().base_address, None);
    }
    set_env_with_result(T0, PromiseResult::Failed);
    assert!(panic_message(|| {
        p.on_derived_key();
    })
    .starts_with("ERR_DERIVE_FAILED"));
    activate_with(&mut p, mpc_key().verifying_key());
    assert_eq!(p.get_config().base_address, Some(base_address()));
}

#[test]
#[should_panic(expected = "ERR_ALREADY_ACTIVATED")]
fn activate_twice_is_rejected() {
    let mut p = new_policy();
    set_env(stranger(), T0);
    let _ = p.activate();
}

#[test]
#[should_panic(expected = "ERR_NOT_ENOUGH_GAS: attach 50 TGas to activate")]
fn activate_with_too_little_gas_is_rejected() {
    let mut p = new_unactivated_policy();
    let mut ctx = context(stranger(), T0);
    ctx.prepaid_gas = Gas::from_tgas(20);
    testing_env!(ctx);
    let _ = p.activate();
}

#[test]
fn config_and_status_views_report_initial_state() {
    let p = new_policy();
    let c = p.get_config();
    assert_eq!(c.version, "2.1.0");
    assert_eq!(c.owner, owner());
    assert_eq!(c.agent, agent());
    assert_eq!(c.base_address, Some(base_address()));
    assert_eq!(c.on_behalf_of, BORROWER);
    assert_eq!(c.chain_id, 8453);
    assert_eq!(c.aave_pool, POOL);
    assert_eq!(c.usdc_base, USDC);
    assert_eq!(c.usdc_near, usdc_near());
    assert_eq!(c.bridge_dest_asset, DEST_ASSET);
    assert_eq!(c.bridge_signer_pk, bridge_pk());
    assert_eq!(c.mpc_contract, mpc());
    assert_eq!(c.derivation_path, "backstop-base-1");
    let s = p.get_status();
    assert_eq!(
        s,
        StatusView {
            spent_today: U128(0),
            day_start: U64(DAY0),
            last_rescue_at: U64(0),
            rescue_count: 0,
            remaining_today: U128(8 * USDC_1),
            cooldown_ends_at: U64(0),
            bridge_spent_today: U128(0),
            bridge_remaining_today: U128(8 * USDC_1),
            last_bridge_at: U64(0),
            bridge_cooldown_ends_at: U64(0),
            bridge_count: 0,
            last_approve_at: U64(0),
            last_bridge: None,
        }
    );
    let l = p.get_limits();
    assert_eq!(l.limits, limits());
    assert!(!l.paused);
}

#[test]
fn get_limits_json_is_flat_with_paused() {
    let p = new_policy();
    let v = serde_json::to_value(p.get_limits()).unwrap();
    assert_eq!(v["max_per_rescue"], "5000000");
    assert_eq!(v["cooldown_secs"], 600);
    assert_eq!(v["paused"], false);
}

#[test]
fn get_config_json_reports_null_base_address_before_activation() {
    let p = new_unactivated_policy();
    let v = serde_json::to_value(p.get_config()).unwrap();
    assert_eq!(v["base_address"], Value::Null);
    assert_eq!(v["bridge_signer_pk"], bridge_pk());
}

#[test]
fn real_one_click_key_round_trips() {
    set_env(policy_account(), T0);
    let p = new_policy_with(BORROWER, ONE_CLICK_PK);
    assert_eq!(p.get_config().bridge_signer_pk, ONE_CLICK_PK);
    assert_eq!(hex::encode(p.bridge_signer_pk), "0cb7e949e3871ecf284a50b8e774ab29b3f7b2363e398cef1df2e94457b7e943");
}

// ------------------------------------------------------------------ owner

#[test]
fn owner_methods_require_one_yocto_so_function_call_keys_cannot_use_them() {
    type OwnerCall = fn(&mut Policy);
    let calls: [(&str, OwnerCall); 8] = [
        ("set_limits", |p| p.set_limits(limits())),
        ("set_agent", |p| p.set_agent(agent())),
        ("set_on_behalf_of", |p| p.set_on_behalf_of(BORROWER.into())),
        ("set_bridge_signer", |p| p.set_bridge_signer(bridge_pk())),
        ("unpause", |p| p.unpause()),
        ("withdraw", |p| {
            let _ = p.withdraw(U128(USDC_1));
        }),
        ("withdraw_near", |p| {
            let _ = p.withdraw_near(U128(1));
        }),
        ("approve_pool (owner)", |p| {
            let _ = p.approve_pool(U64(0), U128(GWEI / 10), U128(0), U128(100_000));
        }),
    ];
    for (name, call) in calls {
        let mut p = new_policy();
        set_env(owner(), T0);
        let msg = panic_message(|| call(&mut p));
        assert_eq!(msg, "Requires attached deposit of exactly 1 yoctoNEAR", "{name}");
        // and the owner check comes first
        let mut p = new_policy();
        set_env_yocto(stranger(), T0);
        let msg = panic_message(|| call(&mut p));
        assert!(msg == "ERR_NOT_OWNER" || msg == "ERR_NOT_AGENT_OR_OWNER", "{name}: {msg}");
    }
    // more than 1 yocto is refused too
    let mut p = new_policy();
    testing_env!(builder(owner(), T0, NearToken::from_yoctonear(2)).build());
    let msg = panic_message(|| {
        let _ = p.approve_pool(U64(0), U128(GWEI / 10), U128(0), U128(100_000));
    });
    assert_eq!(msg, "Requires attached deposit of exactly 1 yoctoNEAR");
}

#[test]
fn pause_needs_no_deposit() {
    let mut p = new_policy();
    set_env(owner(), T0);
    p.pause();
    assert!(p.get_limits().paused);
    assert_eq!(event(&get_logs()[0])["event"], "paused");
}

#[test]
#[should_panic(expected = "ERR_NOT_OWNER")]
fn only_owner_can_set_limits() {
    let mut p = new_policy();
    set_env_yocto(agent(), T0);
    p.set_limits(Limits { max_per_rescue: U128(8 * USDC_1), ..limits() });
}

#[test]
fn owner_can_set_limits_and_event_is_emitted() {
    let mut p = new_policy();
    set_env_yocto(owner(), T0);
    let l = Limits { max_per_rescue: U128(USDC_1), ..limits() };
    p.set_limits(l.clone());
    assert_eq!(p.get_limits().limits, l);
    let e = event(&get_logs()[0]);
    assert_eq!(e["event"], "limits_updated");
    assert_eq!(e["data"][0]["max_per_rescue"], "1000000");
}

#[test]
#[should_panic(expected = "ERR_MAX_PER_RESCUE_ABOVE_DAILY_CAP")]
fn set_limits_rejects_max_per_rescue_above_daily_cap() {
    let mut p = new_policy();
    set_env_yocto(owner(), T0);
    p.set_limits(Limits { max_per_rescue: U128(9 * USDC_1), ..limits() });
}

#[test]
#[should_panic(expected = "ERR_TARGET_HF_NOT_ABOVE_TRIGGER")]
fn set_limits_rejects_target_not_above_trigger() {
    let mut p = new_policy();
    set_env_yocto(owner(), T0);
    p.set_limits(Limits { target_hf_bps: 11_000, ..limits() });
}

#[test]
#[should_panic(expected = "ERR_COOLDOWN_ZERO")]
fn set_limits_rejects_zero_cooldown_so_a_stolen_agent_key_cannot_spam_rescues() {
    let mut p = new_policy();
    set_env_yocto(owner(), T0);
    p.set_limits(Limits { cooldown_secs: 0, ..limits() });
}

#[test]
#[should_panic(expected = "ERR_NOT_OWNER")]
fn only_owner_can_pause() {
    let mut p = new_policy();
    set_env(agent(), T0);
    p.pause();
}

#[test]
#[should_panic(expected = "ERR_NOT_OWNER")]
fn only_owner_can_unpause() {
    let mut p = new_policy();
    set_env(owner(), T0);
    p.pause();
    set_env_yocto(agent(), T0);
    p.unpause();
}

#[test]
#[should_panic(expected = "ERR_NOT_OWNER")]
fn only_owner_can_set_agent() {
    let mut p = new_policy();
    set_env_yocto(agent(), T0);
    p.set_agent(agent());
}

#[test]
fn owner_can_rotate_agent_and_old_agent_loses_access() {
    let mut p = new_policy();
    set_env_yocto(owner(), T0);
    let new_agent: AccountId = "agent2.near".parse().unwrap();
    p.set_agent(new_agent.clone());
    assert_eq!(p.get_config().agent, new_agent);
    set_env(agent(), T0);
    let msg = panic_message(|| {
        let _ = p.rescue(U128(USDC_1), U64(0), U128(GWEI / 10), U128(GWEI / 100), U128(300_000));
    });
    assert_eq!(msg, "ERR_NOT_AGENT");
}

#[test]
#[should_panic(expected = "ERR_NOT_OWNER")]
fn only_owner_can_set_on_behalf_of() {
    let mut p = new_policy();
    set_env_yocto(agent(), T0);
    p.set_on_behalf_of(POOL.into());
}

#[test]
fn owner_can_set_on_behalf_of_and_event_is_emitted() {
    let mut p = new_policy();
    set_env_yocto(owner(), T0);
    p.set_on_behalf_of("0xABCDEF0000000000000000000000000000000001".into());
    assert_eq!(p.get_config().on_behalf_of, "0xabcdef0000000000000000000000000000000001");
    let e = event(&get_logs()[0]);
    assert_eq!(e["event"], "borrower_updated");
    assert_eq!(e["data"][0]["old"], BORROWER);
    assert_eq!(e["data"][0]["new"], "0xabcdef0000000000000000000000000000000001");
}

#[test]
#[should_panic(expected = "ERR_EVM_ADDRESS_LENGTH: on_behalf_of")]
fn set_on_behalf_of_rejects_malformed_address() {
    let mut p = new_policy();
    set_env_yocto(owner(), T0);
    p.set_on_behalf_of("0x12".into());
}

#[test]
#[should_panic(expected = "ERR_NOT_OWNER")]
fn only_owner_can_set_bridge_signer() {
    let mut p = new_policy();
    set_env_yocto(agent(), T0);
    p.set_bridge_signer(ONE_CLICK_PK.into());
}

#[test]
fn owner_can_set_bridge_signer_and_event_is_emitted() {
    let mut p = new_policy();
    set_env_yocto(owner(), T0);
    p.set_bridge_signer(ONE_CLICK_PK.into());
    assert_eq!(p.get_config().bridge_signer_pk, ONE_CLICK_PK);
    let e = event(&get_logs()[0]);
    assert_eq!(e["event"], "bridge_signer_updated");
    assert_eq!(e["data"][0]["old"], bridge_pk());
    assert_eq!(e["data"][0]["new"], ONE_CLICK_PK);
}

#[test]
#[should_panic(expected = "ERR_BRIDGE_SIGNER_FORMAT")]
fn set_bridge_signer_rejects_malformed_key() {
    let mut p = new_policy();
    set_env_yocto(owner(), T0);
    p.set_bridge_signer("ed25519:abc".into());
}

// ------------------------------------------------------------------ deposits and withdrawals

#[test]
#[should_panic(expected = "ERR_NOT_OWNER")]
fn only_owner_can_withdraw() {
    let mut p = new_policy();
    set_env_yocto(agent(), T0);
    let _ = p.withdraw(U128(USDC_1));
}

#[test]
fn withdraw_sends_usdc_only_to_owner() {
    let mut p = new_policy();
    set_env_yocto(owner(), T0);
    let _ = p.withdraw(U128(1_500_000));
    let receipts = get_created_receipts();
    assert_eq!(receipts[0].receiver_id, usdc_near());
    assert_eq!(receipts[0].actions.len(), 1);
    let (method, args, deposit, gas) = call_of(&receipts[0].actions[0]);
    assert_eq!(method, "ft_transfer");
    assert_eq!(args, json!({ "receiver_id": "owner.near", "amount": "1500000", "memo": "backstop withdraw" }));
    assert_eq!(deposit, ONE_YOCTO);
    assert_eq!(gas, FT_TRANSFER_GAS);
    assert_eq!(receipts[1].receiver_id, policy_account());
    let (method, args, _, gas) = call_of(&receipts[1].actions[0]);
    assert_eq!(method, "on_withdrawn");
    assert_eq!(args, json!({ "amount": "1500000" }));
    assert_eq!(gas, WITHDRAW_CALLBACK_GAS);

    set_env_with_result(T0, PromiseResult::Successful(vec![]));
    assert_eq!(p.on_withdrawn(U128(1_500_000)), U128(1_500_000));
    let e = event(&get_logs()[0]);
    assert_eq!(e["event"], "withdrawn");
    assert_eq!(e["data"][0], json!({ "to": "owner.near", "amount": "1500000" }));
}

#[test]
fn withdraw_works_while_paused() {
    let mut p = new_policy();
    set_env(owner(), T0);
    p.pause();
    set_env_yocto(owner(), T0);
    let _ = p.withdraw(U128(USDC_1));
    assert_eq!(get_created_receipts()[0].receiver_id, usdc_near());
}

#[test]
#[should_panic(expected = "ERR_ZERO_AMOUNT")]
fn withdraw_of_zero_is_rejected() {
    let mut p = new_policy();
    set_env_yocto(owner(), T0);
    let _ = p.withdraw(U128(0));
}

#[test]
#[should_panic(expected = "ERR_NOT_ENOUGH_GAS: attach 50 TGas to withdraw")]
fn withdraw_with_too_little_gas_is_rejected() {
    let mut p = new_policy();
    let mut ctx = builder(owner(), T0, ONE_YOCTO).build();
    ctx.prepaid_gas = Gas::from_tgas(30);
    testing_env!(ctx);
    let _ = p.withdraw(U128(USDC_1));
}

#[test]
#[should_panic(expected = "ERR_WITHDRAW_FAILED")]
fn failed_withdraw_transfer_fails_the_transaction() {
    let mut p = new_policy();
    set_env_with_result(T0, PromiseResult::Failed);
    p.on_withdrawn(U128(USDC_1));
}

#[test]
fn withdraw_near_keeps_storage_and_reserve() {
    let mut p = new_policy();
    let env_with_balance = || {
        testing_env!(builder(owner(), T0, ONE_YOCTO).account_balance(NearToken::from_near(5)).build());
        let keep = env::storage_byte_cost()
            .saturating_mul(u128::from(env::storage_usage()))
            .saturating_add(MIN_NEAR_RESERVE);
        env::account_balance().as_yoctonear() - keep.as_yoctonear()
    };

    let available = env_with_balance();
    assert!(available > 0 && available < NearToken::from_near(5).as_yoctonear());
    for too_much in [available + 1, u128::MAX] {
        let msg = panic_message(|| {
            let _ = p.withdraw_near(U128(too_much));
        });
        assert!(msg.starts_with("ERR_NEAR_RESERVE"), "{msg}");
    }

    let available = env_with_balance();
    let _ = p.withdraw_near(U128(available));
    let receipts = get_created_receipts();
    assert_eq!(receipts[0].receiver_id, owner(), "NEAR goes only to the owner");
    assert!(matches!(receipts[0].actions[0], MockAction::Transfer { deposit, .. } if deposit.as_yoctonear() == available));
    assert_eq!(event(&get_logs()[0])["event"], "near_withdrawn");
}

#[test]
fn ft_on_transfer_keeps_usdc_and_emits_deposit() {
    let mut p = new_policy();
    set_env(usdc_near(), T0);
    assert_eq!(p.ft_on_transfer(stranger(), U128(2 * USDC_1), "anything".into()), U128(0));
    let e = event(&get_logs()[0]);
    assert_eq!(e["event"], "deposit");
    assert_eq!(e["data"][0], json!({ "sender": "stranger.near", "amount": "2000000" }));
}

#[test]
fn ft_on_transfer_refunds_any_other_token() {
    let mut p = new_policy();
    set_env("fake-usdc.near".parse().unwrap(), T0);
    assert_eq!(p.ft_on_transfer(owner(), U128(2 * USDC_1), String::new()), U128(2 * USDC_1));
    assert!(get_logs().is_empty());
}

#[test]
fn ft_on_transfer_works_while_paused_and_before_activation() {
    let mut p = new_unactivated_policy();
    set_env(owner(), T0);
    p.pause();
    set_env(usdc_near(), T0);
    assert_eq!(p.ft_on_transfer(owner(), U128(USDC_1), String::new()), U128(0));
}

// ------------------------------------------------------------------ rescue rejections

fn try_rescue(p: &mut Policy, caller: AccountId, now: u64, amount: u128, fee: u128, prio: u128, gas: u128) {
    set_env(caller, now);
    let _ = p.rescue(U128(amount), U64(0), U128(fee), U128(prio), U128(gas));
}

#[test]
#[should_panic(expected = "ERR_NOT_AGENT")]
fn only_agent_can_call_rescue() {
    let mut p = new_policy();
    try_rescue(&mut p, stranger(), T0, USDC_1, GWEI / 10, 0, 300_000);
}

/// Decision: the owner is not implicitly allowed to rescue; only the configured agent is.
#[test]
#[should_panic(expected = "ERR_NOT_AGENT")]
fn owner_cannot_call_rescue_unless_agent() {
    let mut p = new_policy();
    try_rescue(&mut p, owner(), T0, USDC_1, GWEI / 10, 0, 300_000);
}

#[test]
fn owner_can_rescue_after_setting_itself_as_agent() {
    let mut p = new_policy();
    set_env_yocto(owner(), T0);
    p.set_agent(owner());
    try_rescue(&mut p, owner(), T0, USDC_1, GWEI / 10, 0, 300_000);
    assert_eq!(p.get_status().spent_today, U128(USDC_1));
}

#[test]
#[should_panic(expected = "ERR_PAUSED")]
fn paused_contract_rejects_rescue() {
    let mut p = new_policy();
    set_env(owner(), T0);
    p.pause();
    try_rescue(&mut p, agent(), T0, USDC_1, GWEI / 10, 0, 300_000);
}

#[test]
fn unpause_restores_rescue() {
    let mut p = new_policy();
    set_env(owner(), T0);
    p.pause();
    set_env_yocto(owner(), T0);
    p.unpause();
    try_rescue(&mut p, agent(), T0, USDC_1, GWEI / 10, 0, 300_000);
    assert_eq!(p.get_status().rescue_count, 1);
}

#[test]
#[should_panic(expected = "ERR_ZERO_AMOUNT")]
fn zero_amount_rejected() {
    let mut p = new_policy();
    try_rescue(&mut p, agent(), T0, 0, GWEI / 10, 0, 300_000);
}

#[test]
#[should_panic(expected = "ERR_OVER_MAX_PER_RESCUE")]
fn agent_cannot_exceed_max_per_rescue() {
    let mut p = new_policy();
    try_rescue(&mut p, agent(), T0, 5 * USDC_1 + 1, GWEI / 10, 0, 300_000);
}

#[test]
fn agent_can_rescue_exactly_max_per_rescue() {
    let mut p = new_policy();
    try_rescue(&mut p, agent(), T0, 5 * USDC_1, GWEI / 10, 0, 300_000);
    assert_eq!(p.get_status().remaining_today, U128(3 * USDC_1));
}

#[test]
#[should_panic(expected = "ERR_OVER_DAILY_CAP")]
fn agent_cannot_exceed_daily_cap() {
    let mut p = new_policy();
    let id = rescue_at(&mut p, T0, 5 * USDC_1);
    expect_signed(sign_pending(&mut p, id, T0));
    // after cooldown, 5 + 4 > 8
    try_rescue(&mut p, agent(), T0 + 600, 4 * USDC_1, GWEI / 10, 0, 300_000);
}

#[test]
fn daily_cap_resets_next_utc_day() {
    let mut p = new_policy();
    let late = DAY0 + DAY - 700;
    let id = rescue_at(&mut p, late, 5 * USDC_1);
    expect_signed(sign_pending(&mut p, id, late));
    // still the same UTC day after the cooldown: 3 left
    set_env(agent(), DAY0 + DAY - 1);
    assert_eq!(p.get_status().remaining_today, U128(3 * USDC_1));
    // first second of the next UTC day: full cap again, even though < 24h since the rescue
    let next_day = DAY0 + DAY;
    set_env(agent(), next_day);
    let s = p.get_status();
    assert_eq!(s.spent_today, U128(0));
    assert_eq!(s.day_start, U64(next_day));
    assert_eq!(s.remaining_today, U128(8 * USDC_1));
    let id = rescue_at(&mut p, next_day, 5 * USDC_1);
    expect_signed(sign_pending(&mut p, id, next_day));
    assert_eq!(p.get_status().spent_today, U128(5 * USDC_1));
}

#[test]
#[should_panic(expected = "ERR_COOLDOWN")]
fn agent_cannot_rescue_during_cooldown() {
    let mut p = new_policy();
    let id = rescue_at(&mut p, T0, USDC_1);
    expect_signed(sign_pending(&mut p, id, T0));
    try_rescue(&mut p, agent(), T0 + 599, USDC_1, GWEI / 10, 0, 300_000);
}

#[test]
fn cooldown_ends_exactly_after_cooldown_secs() {
    let mut p = new_policy();
    let id = rescue_at(&mut p, T0, USDC_1);
    expect_signed(sign_pending(&mut p, id, T0));
    assert_eq!(p.get_status().cooldown_ends_at, U64(T0 + 600));
    try_rescue(&mut p, agent(), T0 + 600, USDC_1, GWEI / 10, 0, 300_000);
    assert_eq!(p.get_status().rescue_count, 2);
}

#[test]
#[should_panic(expected = "ERR_COOLDOWN")]
fn second_rescue_while_first_in_flight_is_rejected() {
    let mut p = new_policy();
    rescue_at(&mut p, T0, USDC_1);
    // the first signature has not come back yet; budget and cooldown are already reserved
    try_rescue(&mut p, agent(), T0 + 1, USDC_1, GWEI / 10, 0, 300_000);
}

#[test]
#[should_panic(expected = "ERR_FEE_ABOVE_CAP")]
fn fee_above_cap_rejected() {
    let mut p = new_policy();
    try_rescue(&mut p, agent(), T0, USDC_1, GWEI + 1, 0, 300_000);
}

#[test]
#[should_panic(expected = "ERR_PRIORITY_FEE_ABOVE_MAX_FEE")]
fn priority_fee_above_max_fee_rejected() {
    let mut p = new_policy();
    try_rescue(&mut p, agent(), T0, USDC_1, GWEI / 10, GWEI / 10 + 1, 300_000);
}

#[test]
#[should_panic(expected = "ERR_GAS_LIMIT_ABOVE_CAP")]
fn gas_limit_above_cap_rejected() {
    let mut p = new_policy();
    try_rescue(&mut p, agent(), T0, USDC_1, GWEI / 10, 0, 400_001);
}

#[test]
#[should_panic(expected = "ERR_NOT_ENOUGH_GAS")]
fn rescue_with_too_little_gas_rejected() {
    let mut p = new_policy();
    let mut ctx = context(agent(), T0);
    ctx.prepaid_gas = Gas::from_tgas(100);
    testing_env!(ctx);
    let _ = p.rescue(U128(USDC_1), U64(0), U128(GWEI / 10), U128(0), U128(300_000));
}

// ------------------------------------------------------------------ the signed repay

#[test]
fn rescue_calls_mpc_sign_with_payload_v2_path_and_domain() {
    let mut p = new_policy();
    let id = rescue_at(&mut p, T0, USDC_1);
    let hash = p.pending.get(&id).unwrap().payload_hash;
    let receipts = get_created_receipts();
    assert_eq!(receipts[0].receiver_id, mpc());
    match &receipts[0].actions[0] {
        MockAction::FunctionCallWeight { method_name, args, attached_deposit, prepaid_gas, gas_weight, .. } => {
            assert_eq!(method_name, b"sign");
            assert_eq!(*attached_deposit, NearToken::from_yoctonear(1));
            assert_eq!(*prepaid_gas, SIGN_STATIC_GAS);
            assert_eq!(gas_weight.0, 1);
            let v: Value = serde_json::from_slice(args).unwrap();
            assert_eq!(
                v,
                json!({ "request": { "payload_v2": { "Ecdsa": hex::encode(hash) }, "path": "backstop-base-1", "domain_id": 0 } })
            );
        }
        other => panic!("unexpected action {other:?}"),
    }
    assert_eq!(receipts[1].receiver_id, policy_account());
    let (method, args, _, gas) = call_of(&receipts[1].actions[0]);
    assert_eq!(method, "on_signed");
    assert_eq!(gas, CALLBACK_GAS);
    assert_eq!(args, json!({ "rescue_id": id }));
}

#[test]
fn contract_builds_repay_on_behalf_of_borrower_only() {
    let mut p = new_policy();
    set_env(agent(), T0);
    let _ = p.rescue(U128(4_250_000), U64(42), U128(GWEI / 2), U128(GWEI / 20), U128(350_000));
    let signed = expect_signed(sign_pending(&mut p, 1, T0));
    let raw = hex_bytes(&signed.signed_tx);
    let tx = decode_signed_tx(&raw);

    assert_eq!(tx.chain_id, 8453);
    assert_eq!(tx.nonce, 42);
    assert_eq!(tx.max_fee_per_gas, GWEI / 2);
    assert_eq!(tx.max_priority_fee_per_gas, GWEI / 20);
    assert_eq!(tx.gas_limit, 350_000);
    assert_eq!(tx.to, hex_bytes(POOL), "to must be the Aave pool");
    assert!(tx.value.is_empty(), "value must be 0");
    assert_eq!(tx.data.len(), 4 + 4 * 32);
    assert_eq!(tx.data[..4], REPAY_SELECTOR, "selector must be repay");
    assert_eq!(tx.data[4..36], left_pad_32(&hex_bytes(USDC)), "asset must be USDC");
    assert_eq!(tx.data[36..68], left_pad_32(&4_250_000u128.to_be_bytes()), "amount");
    assert_eq!(tx.data[68..100], left_pad_32(&[2]), "interest rate mode must be variable (2)");
    assert_eq!(tx.data[100..132], left_pad_32(&hex_bytes(BORROWER)), "onBehalfOf must be the borrower");
    assert_eq!(evm::format_evm_address(&tx.signer), base_address(), "signed by the derived base address");

    assert_eq!(signed.tx_hash, format!("0x{}", hex::encode(env::keccak256_array(&raw))));
    assert_eq!(signed.amount, U128(4_250_000));
    assert_eq!(signed.rescue_id, 1);
    assert_eq!(signed.kind, TxKind::Repay);
    assert_eq!(serde_json::to_value(&signed).unwrap()["kind"], "repay");
}

#[test]
fn changing_borrower_mid_flight_does_not_change_the_signed_tx() {
    let mut p = new_policy();
    let id = rescue_at(&mut p, T0, USDC_1);
    set_env_yocto(owner(), T0);
    p.set_on_behalf_of(POOL.into());
    let signed = expect_signed(sign_pending(&mut p, id, T0));
    let tx = decode_signed_tx(&hex_bytes(&signed.signed_tx));
    assert_eq!(tx.data[100..132], left_pad_32(&hex_bytes(BORROWER)), "the tx MPC signed is the one requested");
}

#[test]
fn happy_path_updates_spent_and_counter() {
    let mut p = new_policy();
    let id = rescue_at(&mut p, T0, 2 * USDC_1);
    // reserved before the signature returns
    let s = p.get_status();
    assert_eq!(s.spent_today, U128(2 * USDC_1));
    assert_eq!(s.rescue_count, 1);
    assert_eq!(s.last_rescue_at, U64(T0));
    let requested = event(&get_logs()[0]);
    assert_eq!(requested["event"], "rescue_requested");
    assert_eq!(requested["data"][0]["kind"], "repay");

    expect_signed(sign_pending(&mut p, id, T0 + 3));
    let s = p.get_status();
    assert_eq!(s.spent_today, U128(2 * USDC_1));
    assert_eq!(s.remaining_today, U128(6 * USDC_1));
    assert_eq!(s.rescue_count, 1);
    assert_eq!(s.cooldown_ends_at, U64(T0 + 600));
    assert!(p.pending.get(&id).is_none(), "pending entry cleared");

    let logs = get_logs();
    assert!(logs[0].starts_with(r#"EVENT_JSON:{"standard":"backstop","version":"2.0.0","event":"rescue_signed","data":[{"#));
    let e = event(&logs[0]);
    assert_eq!(e["data"][0]["rescue_id"], id);
    assert_eq!(e["data"][0]["kind"], "repay");
    assert_eq!(e["data"][0]["amount"], "2000000");
    assert_eq!(e["data"][0]["evm_nonce"], 7);
}

#[test]
fn failed_signature_rolls_back_spent() {
    let mut p = new_policy();
    let id = rescue_at(&mut p, T0, 3 * USDC_1);
    set_env_with_result(T0 + 2, PromiseResult::Failed);
    expect_failed(p.on_signed(id));

    let s = p.get_status();
    assert_eq!(s.spent_today, U128(0));
    assert_eq!(s.last_rescue_at, U64(0));
    assert_eq!(s.rescue_count, 0);
    assert_eq!(s.cooldown_ends_at, U64(0));
    assert!(p.pending.get(&id).is_none());
    let e = event(&get_logs()[0]);
    assert_eq!(e["event"], "rescue_failed");
    assert_eq!(e["data"][0]["reason"], "ERR_MPC_SIGN_FAILED");
    assert_eq!(e["data"][0]["kind"], "repay");

    // the failure path ends in fail_rescue so the caller's tx fails
    let receipts = get_created_receipts();
    assert_eq!(call_of(&receipts[0].actions[0]).0, "fail_rescue");

    // no cooldown left over: the agent may retry right away, and ids are never reused
    let retry = rescue_at(&mut p, T0 + 3, 3 * USDC_1);
    assert_eq!(retry, id + 1);
}

#[test]
fn rollback_restores_previous_cooldown_not_zero() {
    let mut p = new_policy();
    let first = rescue_at(&mut p, T0, USDC_1);
    expect_signed(sign_pending(&mut p, first, T0));
    let second = rescue_at(&mut p, T0 + 700, USDC_1);
    set_env_with_result(T0 + 701, PromiseResult::Failed);
    expect_failed(p.on_signed(second));
    let s = p.get_status();
    assert_eq!(s.spent_today, U128(USDC_1));
    assert_eq!(s.last_rescue_at, U64(T0));
    assert_eq!(s.rescue_count, 1);
}

#[test]
fn signature_from_wrong_key_is_rejected_and_budget_stays_spent() {
    let mut p = new_policy();
    let id = rescue_at(&mut p, T0, USDC_1);
    let hash = p.pending.get(&id).unwrap().payload_hash;
    let other = SigningKey::from_bytes(&[9u8; 32].into()).unwrap();
    set_env_with_result(T0, PromiseResult::Successful(mpc_response(&other, &hash)));
    expect_failed(p.on_signed(id));
    assert_budget_kept(&p, id, T0, USDC_1);
    assert!(get_logs()[0].contains("ERR_SIGNER_NOT_BASE_ADDRESS"));
}

/// MPC answered, so a signature may be public in the `sign` receipt: nothing is restored.
fn assert_budget_kept(p: &Policy, id: u64, requested_at: u64, amount: u128) {
    let s = p.get_status();
    assert_eq!(s.spent_today, U128(amount));
    assert_eq!(s.last_rescue_at, U64(requested_at));
    assert_eq!(s.rescue_count, 1);
    assert!(p.pending.get(&id).is_none());
}

#[test]
fn malformed_sign_response_is_rejected_and_budget_stays_spent() {
    let mut p = new_policy();
    let id = rescue_at(&mut p, T0, USDC_1);
    set_env_with_result(T0, PromiseResult::Successful(b"{\"unexpected\":true}".to_vec()));
    expect_failed(p.on_signed(id));
    assert_budget_kept(&p, id, T0, USDC_1);
    assert!(get_logs()[0].contains("ERR_SIGN_RESPONSE_NO_BIG_R"));
}

#[test]
fn unparseable_valid_signature_cannot_be_used_to_bypass_cooldown_or_daily_cap() {
    // A real signature in a shape the parser does not know (e.g. a changed MPC response format)
    // is still public in the `sign` receipt. Restoring the budget would let the agent repeat
    // rescues without limit and assemble the txs off-chain.
    let mut p = new_policy();
    let id = rescue_at(&mut p, T0, USDC_1);
    let hash = p.pending.get(&id).unwrap().payload_hash;
    let wrapped = format!("[{}]", String::from_utf8(mpc_response(&mpc_key(), &hash)).unwrap());
    set_env_with_result(T0, PromiseResult::Successful(wrapped.into_bytes()));
    expect_failed(p.on_signed(id));
    assert_budget_kept(&p, id, T0, USDC_1);
    set_env(agent(), T0 + 1);
    let err = check_rescue(&p.limits, p.paused, &p.budget, T0 + 1, &RescueRequest {
        amount: USDC_1,
        max_fee_per_gas: 1,
        max_priority_fee_per_gas: 1,
        gas_limit: 1,
    });
    assert_eq!(err, Err("ERR_COOLDOWN"));
}

#[test]
fn oversized_sign_response_is_rejected_and_budget_stays_spent() {
    let mut p = new_policy();
    let id = rescue_at(&mut p, T0, USDC_1);
    set_env_with_result(T0, PromiseResult::Successful(vec![b' '; MAX_SIGN_RESPONSE_LEN + 1]));
    expect_failed(p.on_signed(id));
    assert_budget_kept(&p, id, T0, USDC_1);
    assert!(get_logs()[0].contains("ERR_MPC_RESPONSE_TOO_LONG"));
}

#[test]
#[should_panic(expected = "ERR_RESCUE_FAILED: rescue 4 not signed (ERR_SIGNER_NOT_BASE_ADDRESS); budget kept")]
fn fail_rescue_says_budget_kept_when_mpc_answered() {
    let p = new_policy();
    set_env(policy_account(), T0);
    p.fail_rescue(4, "ERR_SIGNER_NOT_BASE_ADDRESS".into());
}

#[test]
#[should_panic(expected = "ERR_RESCUE_FAILED: rescue 3 not signed (ERR_MPC_SIGN_FAILED); budget restored")]
fn fail_rescue_makes_the_transaction_fail() {
    let p = new_policy();
    set_env(policy_account(), T0);
    p.fail_rescue(3, "ERR_MPC_SIGN_FAILED".into());
}

#[test]
#[should_panic(expected = "ERR_UNKNOWN_RESCUE")]
fn signature_cannot_be_delivered_twice() {
    let mut p = new_policy();
    let id = rescue_at(&mut p, T0, USDC_1);
    expect_signed(sign_pending(&mut p, id, T0));
    set_env_with_result(T0, PromiseResult::Successful(b"{}".to_vec()));
    let _ = p.on_signed(id);
}

// ------------------------------------------------------------------ approve_pool

fn approve_as(p: &mut Policy, caller: AccountId, deposit: NearToken, now: u64) -> u64 {
    testing_env!(builder(caller, now, deposit).build());
    let _ = p.approve_pool(U64(3), U128(GWEI / 10), U128(GWEI / 100), U128(100_000));
    p.next_rescue_id - 1
}

#[test]
fn approve_pool_signs_approve_of_exactly_daily_cap_to_aave_pool() {
    let mut p = new_policy();
    let id = approve_as(&mut p, agent(), ZERO, T0);
    assert_eq!(event(&get_logs()[0])["data"][0]["kind"], "approve_pool");
    let signed = expect_signed(sign_pending(&mut p, id, T0));
    assert_eq!(signed.kind, TxKind::ApprovePool);
    assert_eq!(serde_json::to_value(&signed).unwrap()["kind"], "approve_pool");
    assert_eq!(signed.amount, U128(8 * USDC_1));
    let tx = decode_signed_tx(&hex_bytes(&signed.signed_tx));
    assert_eq!(tx.to, hex_bytes(USDC), "to must be Base USDC");
    assert!(tx.value.is_empty());
    assert_eq!(tx.nonce, 3);
    assert_eq!(tx.data.len(), 4 + 2 * 32);
    assert_eq!(tx.data[..4], APPROVE_SELECTOR);
    assert_eq!(tx.data[4..36], left_pad_32(&hex_bytes(POOL)), "spender must be the Aave pool");
    assert_eq!(tx.data[36..68], left_pad_32(&(8 * USDC_1).to_be_bytes()), "amount must be daily_cap");
    assert_eq!(evm::format_evm_address(&tx.signer), base_address());
    let s = p.get_status();
    assert_eq!(s.last_approve_at, U64(T0));
    assert_eq!(s.rescue_count, 0, "approvals are not rescues");
    assert_eq!(s.spent_today, U128(0), "approvals do not touch the rescue budget");
}

#[test]
fn owner_can_approve_pool_with_one_yocto_even_while_paused() {
    let mut p = new_policy();
    set_env(owner(), T0);
    p.pause();
    let id = approve_as(&mut p, owner(), ONE_YOCTO, T0);
    expect_signed(sign_pending(&mut p, id, T0));
}

#[test]
fn approve_pool_is_rate_limited() {
    let mut p = new_policy();
    let id = approve_as(&mut p, agent(), ZERO, T0);
    expect_signed(sign_pending(&mut p, id, T0));
    let msg = panic_message(|| {
        approve_as(&mut p, agent(), ZERO, T0 + APPROVE_MIN_INTERVAL_SECS - 1);
    });
    assert_eq!(msg, "ERR_APPROVE_TOO_SOON");
    let msg = panic_message(|| {
        approve_as(&mut p, owner(), ONE_YOCTO, T0 + 10);
    });
    assert_eq!(msg, "ERR_APPROVE_TOO_SOON", "the owner path is rate-limited too");
    approve_as(&mut p, agent(), ZERO, T0 + APPROVE_MIN_INTERVAL_SECS);
    assert_eq!(p.get_status().last_approve_at, U64(T0 + APPROVE_MIN_INTERVAL_SECS));
}

#[test]
#[should_panic(expected = "ERR_PAUSED")]
fn agent_cannot_approve_while_paused() {
    let mut p = new_policy();
    set_env(owner(), T0);
    p.pause();
    approve_as(&mut p, agent(), ZERO, T0);
}

#[test]
#[should_panic(expected = "ERR_NOT_AGENT_OR_OWNER")]
fn stranger_cannot_approve_pool() {
    let mut p = new_policy();
    approve_as(&mut p, stranger(), ZERO, T0);
}

#[test]
fn approve_pool_respects_fee_and_gas_caps() {
    let cases: [(u128, u128, u128, &str); 3] = [
        (GWEI + 1, 0, 100_000, "ERR_FEE_ABOVE_CAP"),
        (GWEI / 10, GWEI / 10 + 1, 100_000, "ERR_PRIORITY_FEE_ABOVE_MAX_FEE"),
        (GWEI / 10, 0, 400_001, "ERR_GAS_LIMIT_ABOVE_CAP"),
    ];
    for (fee, prio, gas, code) in cases {
        let mut p = new_policy();
        set_env(agent(), T0);
        let msg = panic_message(|| {
            let _ = p.approve_pool(U64(0), U128(fee), U128(prio), U128(gas));
        });
        assert_eq!(msg, code);
    }
}

#[test]
fn failed_approve_signature_restores_last_approve_at() {
    let mut p = new_policy();
    let first = approve_as(&mut p, agent(), ZERO, T0);
    expect_signed(sign_pending(&mut p, first, T0));
    let later = T0 + APPROVE_MIN_INTERVAL_SECS;
    let second = approve_as(&mut p, agent(), ZERO, later);
    set_env_with_result(later + 1, PromiseResult::Failed);
    expect_failed(p.on_signed(second));
    assert_eq!(p.get_status().last_approve_at, U64(T0), "back to the previous approval, not zero");
    assert_eq!(p.get_status().rescue_count, 0);
    // the agent may retry right away
    approve_as(&mut p, agent(), ZERO, later + 2);
}

// ------------------------------------------------------------------ signature assembly (pure)

fn sample_tx(nonce: u64) -> omni_transaction::evm::EVMTransaction {
    EvmCall {
        chain_id: 8453,
        nonce,
        to: evm::parse_evm_address(POOL).unwrap(),
        value: 0,
        data: encode_repay(&evm::parse_evm_address(USDC).unwrap(), USDC_1, &eth_address(mpc_key().verifying_key())),
        max_fee_per_gas: GWEI / 10,
        max_priority_fee_per_gas: GWEI / 100,
        gas_limit: 300_000,
    }
    .build()
}

#[test]
fn signed_tx_from_known_secp256k1_signature_recovers_to_signer() {
    set_env(policy_account(), T0);
    let key = mpc_key();
    let tx = sample_tx(0);
    let hash = evm::signing_hash(&tx);
    let sig = parse_sign_response(&mpc_response(&key, &hash)).unwrap();
    assert!(evm::signer_matches(&hash, &sig, &eth_address(key.verifying_key())), "near ecrecover agrees");
    let raw = assemble_signed_tx(&tx, &sig);
    let decoded = decode_signed_tx(&raw);
    assert_eq!(decoded.signer, eth_address(key.verifying_key()));
}

#[test]
fn signature_with_leading_zero_r_is_encoded_canonically() {
    set_env(policy_account(), T0);
    let key = mpc_key();
    let (tx, sig) = (0u64..)
        .map(|n| {
            let tx = sample_tx(n);
            let sig = parse_sign_response(&mpc_response(&key, &evm::signing_hash(&tx))).unwrap();
            (tx, sig)
        })
        .find(|(_, sig)| sig.r[0] == 0)
        .unwrap();
    let decoded = decode_signed_tx(&assemble_signed_tx(&tx, &sig));
    assert_eq!(decoded.signer, eth_address(key.verifying_key()));
}

#[test]
fn high_s_signature_is_normalized_to_low_s() {
    set_env(policy_account(), T0);
    let key = mpc_key();
    let tx = sample_tx(1);
    let hash = evm::signing_hash(&tx);
    let (sig, recid) = key.sign_prehash_recoverable(&hash).unwrap();
    // the same signature in its high-s form: (r, n - s) with flipped parity
    let r: [u8; 32] = sig.r().to_bytes().into();
    let low_s: [u8; 32] = sig.s().to_bytes().into();
    let unchanged = normalize_low_s(r, low_s, recid.to_byte());
    assert_eq!(unchanged, RawSignature { r, s: low_s, y_parity: recid.to_byte() }, "low s is unchanged");
    let high_s = (-*sig.s()).to_bytes();
    let high_sig = K256Signature::from_scalars(sig.r().to_bytes(), high_s).unwrap();
    let flipped = RecoveryId::new(!recid.is_y_odd(), recid.is_x_reduced());
    let parsed = parse_sign_response(&response_json(&high_sig, flipped)).unwrap();
    assert_eq!(parsed, RawSignature { r, s: low_s, y_parity: recid.to_byte() });
    let decoded = decode_signed_tx(&assemble_signed_tx(&tx, &parsed));
    assert_eq!(decoded.signer, eth_address(key.verifying_key()));
}

#[test]
fn wrapped_sign_response_is_accepted() {
    set_env(policy_account(), T0);
    let key = mpc_key();
    let hash = evm::signing_hash(&sample_tx(2));
    let inner: Value = serde_json::from_slice(&mpc_response(&key, &hash)).unwrap();
    let wrapped = json!({ "Secp256k1": inner }).to_string();
    let direct = parse_sign_response(&mpc_response(&key, &hash)).unwrap();
    assert_eq!(parse_sign_response(wrapped.as_bytes()).unwrap(), direct);
}

#[test]
fn sign_response_with_bad_recovery_id_is_rejected() {
    let bad = json!({ "big_r": { "affine_point": format!("02{}", "11".repeat(32)) }, "s": { "scalar": "22".repeat(32) }, "recovery_id": 2 });
    assert_eq!(parse_sign_response(bad.to_string().as_bytes()), Err("ERR_SIGN_RESPONSE_RECOVERY_ID"));
}

// ------------------------------------------------------------------ ISO timestamps

/// Inverse of the contract's parser, for building test quotes (H. Hinnant's civil_from_days).
fn iso(secs: u64) -> String {
    let z = secs / DAY + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + u64::from(m <= 2);
    let rem = secs % DAY;
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.123Z", rem / 3_600, rem % 3_600 / 60, rem % 60)
}

#[test]
fn iso_timestamp_parser_matches_known_vectors() {
    // vectors from `date -u -d <ts> +%s`
    for (s, want) in [
        ("2026-11-13T06:03:47.271Z", 1_794_549_827),
        ("1970-01-01T00:00:00Z", 0),
        ("2024-02-29T12:00:00Z", 1_709_208_000),
        ("2026-11-13T06:25:41.546Z", 1_794_551_141),
        ("2099-12-31T23:59:59Z", 4_102_444_799),
        ("2000-03-01T00:00:00Z", 951_868_800),
        ("2026-11-13T06:03:47.123456789Z", 1_794_549_827),
        ("2026-11-13T06:03:47.9Z", 1_794_549_827),
    ] {
        assert_eq!(parse_iso_utc(s), Ok(want), "{s}");
    }
    assert_eq!(parse_iso_utc(&iso(T0)), Ok(T0), "test helper agrees");
    assert_eq!(parse_iso_utc(&iso(1_794_549_827)), Ok(1_794_549_827));
}

#[test]
fn iso_timestamp_parser_rejects_malformed_input() {
    for s in [
        "",
        "2026-11-13",
        "2026-11-13T06:03:47",
        "2026-11-13T06:03:47+00:00",
        "2026-11-13 06:03:47Z",
        "2026-11-13T06:03:47.Z",
        "2026-11-13T06:03:47.1234567890Z",
        "2026-11-13T06:03:47.12aZ",
        "2026-11-13T06:03:47z",
        "2026-11-13T06:03:47ZZ",
        "2026-13-01T00:00:00Z",
        "2026-00-01T00:00:00Z",
        "2026-02-29T00:00:00Z",
        "2100-02-29T00:00:00Z",
        "2026-04-31T00:00:00Z",
        "2026-11-00T00:00:00Z",
        "2026-11-13T24:00:00Z",
        "2026-11-13T23:60:00Z",
        "2026-11-13T23:59:60Z",
        "1969-12-31T23:59:59Z",
        "+026-11-13T06:03:47Z",
        "２026-11-13T06:03:47Z",
        "2026-1a-13T06:03:47Z",
    ] {
        assert_eq!(parse_iso_utc(s), Err("ERR_QUOTE_TIME_FORMAT"), "{s:?}");
    }
}

// ------------------------------------------------------------------ bridge (fund_bridge)

/// A quote that passes every check at `now`, for the test policy (amount 2 USDC, 0.5% loss).
fn valid_quote(now: u64) -> Map<String, Value> {
    let v = json!({
        "amount": "2000000",
        "amountIn": "2000000",
        "amountInFormatted": "2.0",
        "amountInUsd": "1.999",
        "amountOut": "1998000",
        "amountOutFormatted": "1.998",
        "amountOutUsd": "1.997",
        "deadline": iso(now + 3 * DAY),
        "depositAddress": DEPOSIT_ADDRESS,
        "depositType": "ORIGIN_CHAIN",
        "destinationAsset": DEST_ASSET,
        "dry": false,
        "minAmountIn": "2000000",
        "minAmountOut": "1990000",
        "originAsset": format!("nep141:{USDC_NEAR}"),
        "recipient": base_address(),
        "recipientType": "DESTINATION_CHAIN",
        "refundFee": "4152",
        "refundTo": "policy.near",
        "refundType": "ORIGIN_CHAIN",
        "slippageTolerance": 50,
        "swapType": "EXACT_INPUT",
        "timeEstimate": 22,
        "timeWhenInactive": iso(now + 3 * DAY),
        "timestamp": iso(now),
        "withdrawFee": "2400",
    });
    match v {
        Value::Object(m) => m,
        _ => unreachable!(),
    }
}

fn quote_string(q: &Map<String, Value>) -> String {
    serde_json::to_string(q).unwrap()
}

fn sign_quote_with(quote: &str, key: &ed25519_dalek::SigningKey) -> String {
    let message = near_sdk::bs58::encode(env::sha256_array(quote.as_bytes())).into_string();
    bridge::encode_ed25519(&key.sign(message.as_bytes()).to_bytes())
}

fn sign_quote(quote: &str) -> String {
    sign_quote_with(quote, &bridge_key())
}

/// Calls `fund_bridge` as the agent with `q` signed by the test 1Click key; returns the bridge id.
fn fund(p: &mut Policy, now: u64, q: &Map<String, Value>) -> u64 {
    set_env(agent(), now);
    let s = quote_string(q);
    let _ = p.fund_bridge(s.clone(), sign_quote(&s));
    p.next_bridge_id - 1
}

/// Panic message of a `fund_bridge` call with a valid quote modified by `edit`.
fn fund_error(edit: impl FnOnce(&mut Map<String, Value>)) -> String {
    let mut p = new_policy();
    let mut q = valid_quote(T0);
    edit(&mut q);
    panic_message(|| {
        fund(&mut p, T0, &q);
    })
}

fn bridge_succeeds(p: &mut Policy, id: u64, now: u64) -> BridgeFunded {
    set_env_with_result(now, PromiseResult::Successful(vec![]));
    match p.on_bridge_funded(id) {
        PromiseOrValue::Value(v) => v,
        PromiseOrValue::Promise(_) => panic!("expected a funded bridge"),
    }
}

#[test]
fn valid_quote_is_accepted() {
    let mut p = new_policy();
    let id = fund(&mut p, T0, &valid_quote(T0));
    assert_eq!(id, 1);
    let s = p.get_status();
    assert_eq!(s.bridge_spent_today, U128(2 * USDC_1));
    assert_eq!(s.bridge_count, 1);
}

#[test]
#[should_panic(expected = "ERR_NOT_AGENT")]
fn only_agent_can_fund_bridge() {
    let mut p = new_policy();
    set_env(owner(), T0);
    let s = quote_string(&valid_quote(T0));
    let _ = p.fund_bridge(s.clone(), sign_quote(&s));
}

#[test]
#[should_panic(expected = "ERR_NOT_ENOUGH_GAS: attach 150 TGas to fund_bridge")]
fn fund_bridge_with_too_little_gas_is_rejected() {
    let mut p = new_policy();
    let mut ctx = context(agent(), T0);
    ctx.prepaid_gas = Gas::from_tgas(60);
    testing_env!(ctx);
    let s = quote_string(&valid_quote(T0));
    let _ = p.fund_bridge(s.clone(), sign_quote(&s));
}

#[test]
#[should_panic(expected = "ERR_PAUSED")]
fn paused_contract_rejects_fund_bridge() {
    let mut p = new_policy();
    set_env(owner(), T0);
    p.pause();
    fund(&mut p, T0, &valid_quote(T0));
}

#[test]
fn quote_with_invalid_signature_is_rejected() {
    let mut p = new_policy();
    let s = quote_string(&valid_quote(T0));
    let good = sign_quote(&s);
    let mut sig_bytes: [u8; 64] = bridge::decode_ed25519(&good).unwrap();
    sig_bytes[10] ^= 1;
    for (sig, code) in [
        (bridge::encode_ed25519(&sig_bytes), "ERR_QUOTE_SIGNATURE_INVALID"),
        (good.trim_start_matches("ed25519:").to_string(), "ERR_QUOTE_SIGNATURE_FORMAT"),
        ("ed25519:abc".to_string(), "ERR_QUOTE_SIGNATURE_FORMAT"),
        ("ed25519:0OIl".to_string(), "ERR_QUOTE_SIGNATURE_FORMAT"),
        (String::new(), "ERR_QUOTE_SIGNATURE_FORMAT"),
    ] {
        set_env(agent(), T0);
        let msg = panic_message(|| {
            let _ = p.fund_bridge(s.clone(), sig.clone());
        });
        assert_eq!(msg, code, "{sig}");
    }
}

#[test]
#[should_panic(expected = "ERR_QUOTE_SIGNATURE_INVALID")]
fn quote_signed_by_another_key_is_rejected() {
    let mut p = new_policy();
    set_env(agent(), T0);
    let s = quote_string(&valid_quote(T0));
    let other = ed25519_dalek::SigningKey::from_bytes(&[6u8; 32]);
    let _ = p.fund_bridge(s.clone(), sign_quote_with(&s, &other));
}

#[test]
fn tampered_quote_is_rejected() {
    let s = quote_string(&valid_quote(T0));
    let sig = sign_quote(&s);
    // flip one byte inside the deposit address ("ab..." -> "aa...")
    let at = s.find(DEPOSIT_ADDRESS).unwrap() + 1;
    let mut bytes = s.clone().into_bytes();
    bytes[at] = b'a';
    let tampered = String::from_utf8(bytes).unwrap();
    assert_ne!(tampered, s);
    let mut p = new_policy();
    set_env(agent(), T0);
    let msg = panic_message(|| {
        let _ = p.fund_bridge(tampered, sig);
    });
    assert_eq!(msg, "ERR_QUOTE_SIGNATURE_INVALID");
}

#[test]
#[should_panic(expected = "ERR_QUOTE_TOO_LONG")]
fn overlong_quote_is_rejected() {
    let mut p = new_policy();
    let mut q = valid_quote(T0);
    q.insert("referral".into(), json!("x".repeat(MAX_QUOTE_LEN)));
    fund(&mut p, T0, &q);
}

/// The fixture is a real non-dry 1Click quote and its signature (captured 2026-11-13, no deposit
/// made). The policy is set up as the quote's refundTo / recipient, with 1Click's real key.
#[test]
fn live_1click_quote_fixture_verifies() {
    let fixture: Value = serde_json::from_str(include_str!("../tests/fixtures/quote.json")).unwrap();
    let quote = fixture["canonical"].as_str().unwrap().to_string();
    let signature = fixture["signature"].as_str().unwrap().to_string();
    let response = &fixture["response"];
    assert_eq!(signature, response["signature"].as_str().unwrap());
    let refund_to: AccountId = response["quoteRequest"]["refundTo"].as_str().unwrap().parse().unwrap();
    let recipient = response["quoteRequest"]["recipient"].as_str().unwrap();
    let deposit_address = response["quote"]["depositAddress"].as_str().unwrap();
    let ts = parse_iso_utc(response["timestamp"].as_str().unwrap()).unwrap();
    let now = ts + 60;

    let mut ctx = builder(agent(), ts, ZERO);
    ctx.current_account_id(refund_to.clone());
    testing_env!(ctx.build());
    let mut p = new_policy_with(BORROWER, ONE_CLICK_PK);
    p.base_address = Some(evm::parse_evm_address(&recipient.to_ascii_lowercase()).unwrap());

    let pk = p.bridge_signer_pk;
    let hash = verify_quote_signature(&quote, &signature, &pk).expect("1Click's signature verifies");
    let checked = check_quote(
        &quote,
        &QuoteExpectations {
            usdc_near: &usdc_near(),
            dest_asset: DEST_ASSET,
            recipient: &p.base_address.unwrap(),
            refund_to: &refund_to,
            now,
        },
    )
    .expect("every routing check passes");
    assert_eq!(checked.amount_in, 5_000_000);
    assert_eq!(checked.deposit_address.as_str(), deposit_address);

    let mut ctx = builder(agent(), now, ZERO);
    ctx.current_account_id(refund_to.clone());
    testing_env!(ctx.build());
    let _ = p.fund_bridge(quote.clone(), signature.clone());
    let receipts = get_created_receipts();
    assert_eq!(receipts[0].receiver_id, usdc_near());
    let (_, args, _, _) = call_of(&receipts[0].actions[1]);
    assert_eq!(args, json!({ "receiver_id": deposit_address, "amount": "5000000" }));
    assert!(p.used_quotes.contains(&hash));

    // one changed byte and the real signature no longer verifies
    let tampered = quote.replacen("\"amountIn\":\"5000000\"", "\"amountIn\":\"5000001\"", 1);
    assert_eq!(verify_quote_signature(&tampered, &signature, &pk), Err("ERR_QUOTE_SIGNATURE_INVALID"));
}

#[test]
fn quote_with_wrong_recipient_is_rejected() {
    assert_eq!(fund_error(|q| {
        q.insert("recipient".into(), json!(BORROWER));
    }), "ERR_QUOTE_RECIPIENT");
}

#[test]
fn quote_recipient_comparison_ignores_hex_case() {
    let mut p = new_policy();
    let mut q = valid_quote(T0);
    let upper = format!("0x{}", base_address()[2..].to_ascii_uppercase());
    q.insert("recipient".into(), json!(upper));
    fund(&mut p, T0, &q);
    assert_eq!(p.get_status().bridge_count, 1);
}

#[test]
fn quote_with_refund_to_other_account_is_rejected() {
    assert_eq!(fund_error(|q| {
        q.insert("refundTo".into(), json!("owner.near"));
    }), "ERR_QUOTE_REFUND_TO");
}

#[test]
fn quote_with_wrong_origin_asset_is_rejected() {
    assert_eq!(fund_error(|q| {
        q.insert("originAsset".into(), json!("nep141:wrap.near"));
    }), "ERR_QUOTE_ORIGIN_ASSET");
}

#[test]
fn quote_with_wrong_destination_asset_is_rejected() {
    assert_eq!(fund_error(|q| {
        q.insert("destinationAsset".into(), json!("nep141:eth.omft.near"));
    }), "ERR_QUOTE_DESTINATION_ASSET");
}

#[test]
fn dry_quote_is_rejected() {
    assert_eq!(fund_error(|q| {
        q.insert("dry".into(), json!(true));
    }), "ERR_QUOTE_DRY");
}

#[test]
fn exact_output_quote_is_rejected() {
    assert_eq!(fund_error(|q| {
        q.insert("swapType".into(), json!("EXACT_OUTPUT"));
    }), "ERR_QUOTE_SWAP_TYPE");
}

#[test]
fn quote_with_other_routing_types_is_rejected() {
    assert_eq!(fund_error(|q| {
        q.insert("depositType".into(), json!("INTENTS"));
    }), "ERR_QUOTE_DEPOSIT_TYPE");
    assert_eq!(fund_error(|q| {
        q.insert("recipientType".into(), json!("INTENTS"));
    }), "ERR_QUOTE_RECIPIENT_TYPE");
    assert_eq!(fund_error(|q| {
        q.insert("refundType".into(), json!("INTENTS"));
    }), "ERR_QUOTE_REFUND_TYPE");
}

#[test]
fn quote_with_custom_recipient_msg_is_rejected() {
    assert_eq!(fund_error(|q| {
        q.insert("customRecipientMsg".into(), json!("hello"));
    }), "ERR_QUOTE_SHAPE");
}

#[test]
fn quote_with_virtual_chain_recipient_is_rejected() {
    assert_eq!(fund_error(|q| {
        q.insert("virtualChainRecipient".into(), json!("attacker.near"));
    }), "ERR_QUOTE_SHAPE");
    assert_eq!(fund_error(|q| {
        q.insert("virtualChainRefundRecipient".into(), json!("attacker.near"));
    }), "ERR_QUOTE_SHAPE");
}

#[test]
fn quote_with_deposit_memo_is_rejected() {
    assert_eq!(fund_error(|q| {
        q.insert("depositMemo".into(), json!("123"));
    }), "ERR_QUOTE_SHAPE");
}

#[test]
fn quote_with_unknown_field_is_rejected() {
    assert_eq!(fund_error(|q| {
        q.insert("newRoutingOption".into(), json!(1));
    }), "ERR_QUOTE_SHAPE");
    assert_eq!(fund_error(|q| {
        q.remove("recipient");
    }), "ERR_QUOTE_SHAPE", "a missing required field is a shape error too");
    assert_eq!(fund_error(|q| {
        q.insert("amountIn".into(), json!(2_000_000));
    }), "ERR_QUOTE_SHAPE", "amounts must be strings");
}

#[test]
fn quote_deposit_address_must_be_an_implicit_account() {
    for bad in ["attacker.near", &"AB".repeat(32), &"ab".repeat(31), &"ab".repeat(33), &format!("{}g", "a".repeat(63))] {
        let bad = bad.to_string();
        assert_eq!(fund_error(move |q| {
            q.insert("depositAddress".into(), json!(bad));
        }), "ERR_QUOTE_DEPOSIT_ADDRESS");
    }
}

#[test]
fn quote_amounts_must_be_consistent_decimal_strings() {
    assert_eq!(fund_error(|q| {
        q.insert("amountOut".into(), json!("-1"));
    }), "ERR_QUOTE_AMOUNT_FORMAT");
    assert_eq!(fund_error(|q| {
        q.insert("minAmountOut".into(), json!("1e6"));
    }), "ERR_QUOTE_AMOUNT_FORMAT");
    assert_eq!(fund_error(|q| {
        q.insert("amount".into(), json!("340282366920938463463374607431768211456"));
    }), "ERR_QUOTE_AMOUNT_FORMAT");
    assert_eq!(fund_error(|q| {
        q.insert("amount".into(), json!("2000001"));
    }), "ERR_QUOTE_AMOUNT_MISMATCH");
    assert_eq!(fund_error(|q| {
        q.insert("minAmountIn".into(), json!("1"));
    }), "ERR_QUOTE_AMOUNT_MISMATCH");
}

#[test]
fn quote_losing_more_than_two_percent_is_rejected() {
    // exactly 98% passes
    let mut p = new_policy();
    let mut q = valid_quote(T0);
    q.insert("minAmountOut".into(), json!("1960000"));
    fund(&mut p, T0, &q);
    assert_eq!(fund_error(|q| {
        q.insert("minAmountOut".into(), json!("1959999"));
    }), "ERR_QUOTE_LOSS_TOO_HIGH");
}

#[test]
fn stale_quote_is_rejected() {
    let mut p = new_policy();
    let mut q = valid_quote(T0);
    q.insert("timestamp".into(), json!(iso(T0 - MAX_QUOTE_AGE_SECS)));
    fund(&mut p, T0, &q);
    assert_eq!(fund_error(|q| {
        q.insert("timestamp".into(), json!(iso(T0 - MAX_QUOTE_AGE_SECS - 1)));
    }), "ERR_QUOTE_STALE");
    assert_eq!(fund_error(|q| {
        q.insert("timestamp".into(), json!("2025-11-12 01:00:00Z"));
    }), "ERR_QUOTE_TIME_FORMAT");
}

#[test]
fn quote_from_the_future_is_rejected() {
    let mut p = new_policy();
    let mut q = valid_quote(T0);
    q.insert("timestamp".into(), json!(iso(T0 + MAX_QUOTE_FUTURE_SECS)));
    fund(&mut p, T0, &q);
    assert_eq!(fund_error(|q| {
        q.insert("timestamp".into(), json!(iso(T0 + MAX_QUOTE_FUTURE_SECS + 1)));
    }), "ERR_QUOTE_STALE");
}

#[test]
fn quote_whose_deposit_address_expires_soon_is_rejected() {
    let mut p = new_policy();
    let mut q = valid_quote(T0);
    q.insert("deadline".into(), json!(iso(T0 + MIN_QUOTE_DEADLINE_MARGIN_SECS)));
    fund(&mut p, T0, &q);
    assert_eq!(fund_error(|q| {
        q.insert("deadline".into(), json!(iso(T0 + MIN_QUOTE_DEADLINE_MARGIN_SECS - 1)));
    }), "ERR_QUOTE_DEADLINE_TOO_SOON");
    assert_eq!(fund_error(|q| {
        q.insert("deadline".into(), json!("tomorrow"));
    }), "ERR_QUOTE_TIME_FORMAT");
}

#[test]
fn same_quote_cannot_be_used_twice() {
    let mut p = new_policy();
    let q = valid_quote(T0);
    let id = fund(&mut p, T0, &q);
    bridge_succeeds(&mut p, id, T0);
    // even after the cooldown, and even if the first transfer had failed
    let msg = panic_message(|| {
        fund(&mut p, T0 + 600, &q);
    });
    assert_eq!(msg, "ERR_QUOTE_ALREADY_USED");
}

#[test]
fn bridge_cannot_exceed_max_per_rescue() {
    assert_eq!(fund_error(|q| {
        for k in ["amount", "amountIn", "minAmountIn"] {
            q.insert(k.into(), json!("5000001"));
        }
        q.insert("minAmountOut".into(), json!("5000000"));
    }), "ERR_OVER_MAX_PER_RESCUE");
}

fn quote_for(amount: u128, now: u64) -> Map<String, Value> {
    let mut q = valid_quote(now);
    for k in ["amount", "amountIn", "minAmountIn"] {
        q.insert(k.into(), json!(amount.to_string()));
    }
    q.insert("minAmountOut".into(), json!((amount * 99 / 100).to_string()));
    q
}

#[test]
fn bridge_cannot_exceed_daily_cap() {
    let mut p = new_policy();
    let id = fund(&mut p, T0, &quote_for(5 * USDC_1, T0));
    bridge_succeeds(&mut p, id, T0);
    let msg = panic_message(|| {
        fund(&mut p, T0 + 600, &quote_for(4 * USDC_1, T0 + 600));
    });
    assert_eq!(msg, "ERR_OVER_DAILY_CAP");
    fund(&mut p, T0 + 600, &quote_for(3 * USDC_1, T0 + 600));
    assert_eq!(p.get_status().bridge_remaining_today, U128(0));
}

#[test]
fn bridge_daily_cap_resets_next_utc_day() {
    let mut p = new_policy();
    let late = DAY0 + DAY - 700;
    let id = fund(&mut p, late, &quote_for(5 * USDC_1, late));
    bridge_succeeds(&mut p, id, late);
    let next_day = DAY0 + DAY;
    set_env(agent(), next_day);
    assert_eq!(p.get_status().bridge_remaining_today, U128(8 * USDC_1));
    fund(&mut p, next_day, &quote_for(5 * USDC_1, next_day));
    assert_eq!(p.get_status().bridge_spent_today, U128(5 * USDC_1));
}

#[test]
fn bridge_cooldown_blocks_a_second_bridge() {
    let mut p = new_policy();
    let id = fund(&mut p, T0, &quote_for(USDC_1, T0));
    bridge_succeeds(&mut p, id, T0);
    assert_eq!(p.get_status().bridge_cooldown_ends_at, U64(T0 + 600));
    let msg = panic_message(|| {
        fund(&mut p, T0 + 599, &quote_for(USDC_1, T0 + 599));
    });
    assert_eq!(msg, "ERR_COOLDOWN");
    fund(&mut p, T0 + 600, &quote_for(USDC_1, T0 + 600));
}

#[test]
fn dust_bridge_is_rejected() {
    assert_eq!(fund_error(|q| {
        for k in ["amount", "amountIn", "minAmountIn", "minAmountOut"] {
            q.insert(k.into(), json!((MIN_BRIDGE_AMOUNT - 1).to_string()));
        }
    }), "ERR_BRIDGE_AMOUNT_TOO_SMALL");
}

#[test]
fn bridge_budget_is_separate_from_rescue_budget() {
    let mut p = new_policy();
    let id = rescue_at(&mut p, T0, 5 * USDC_1);
    expect_signed(sign_pending(&mut p, id, T0));
    // the rescue cooldown and spend do not block a bridge, and vice versa
    let b = fund(&mut p, T0 + 1, &quote_for(5 * USDC_1, T0 + 1));
    bridge_succeeds(&mut p, b, T0 + 1);
    let s = p.get_status();
    assert_eq!(s.spent_today, U128(5 * USDC_1));
    assert_eq!(s.bridge_spent_today, U128(5 * USDC_1));
    assert_eq!(s.rescue_count, 1);
    assert_eq!(s.bridge_count, 1);
    assert_eq!(s.cooldown_ends_at, U64(T0 + 600));
    assert_eq!(s.bridge_cooldown_ends_at, U64(T0 + 601));
}

#[test]
fn fund_bridge_registers_deposit_address_and_transfers_exact_amount_in_one_batch() {
    let mut p = new_policy();
    let id = fund(&mut p, T0, &valid_quote(T0));
    let receipts = get_created_receipts();
    assert_eq!(receipts.len(), 2);
    assert_eq!(receipts[0].receiver_id, usdc_near(), "only the USDC token is called");
    assert_eq!(receipts[0].actions.len(), 2, "both actions in one receipt: atomic");
    let (method, args, deposit, gas) = call_of(&receipts[0].actions[0]);
    assert_eq!(method, "storage_deposit");
    assert_eq!(args, json!({ "account_id": DEPOSIT_ADDRESS, "registration_only": true }));
    assert_eq!(deposit, FT_STORAGE_DEPOSIT);
    assert_eq!(gas, FT_STORAGE_GAS);
    let (method, args, deposit, gas) = call_of(&receipts[0].actions[1]);
    assert_eq!(method, "ft_transfer");
    assert_eq!(args, json!({ "receiver_id": DEPOSIT_ADDRESS, "amount": "2000000" }));
    assert_eq!(deposit, ONE_YOCTO);
    assert_eq!(gas, FT_TRANSFER_GAS);
    assert_eq!(receipts[1].receiver_id, policy_account());
    let (method, args, _, gas) = call_of(&receipts[1].actions[0]);
    assert_eq!(method, "on_bridge_funded");
    assert_eq!(args, json!({ "bridge_id": id }));
    assert_eq!(gas, BRIDGE_CALLBACK_GAS);
    let e = event(&get_logs()[0]);
    assert_eq!(e["event"], "bridge_requested");
    assert_eq!(e["data"][0]["deposit_address"], DEPOSIT_ADDRESS);
    assert_eq!(e["data"][0]["amount_in"], "2000000");
    assert_eq!(e["data"][0]["min_amount_out"], "1990000");
}

/// `fund_bridge` on a policy with `fee_bps`, for a 2 USDC quote.
fn fee_bridge_receipts(fee_bps: u32) -> (Vec<near_sdk::mock::Receipt>, Value) {
    set_env(policy_account(), T0);
    let mut p = new_policy_with_fee(BORROWER, &bridge_pk(), fee_bps);
    activate_with(&mut p, mpc_key().verifying_key());
    fund(&mut p, T0, &valid_quote(T0));
    (get_created_receipts(), event(&get_logs()[0]))
}

#[test]
fn bridge_pays_the_service_fee_to_the_fee_account_in_the_same_atomic_batch() {
    let (receipts, e) = fee_bridge_receipts(10);
    assert_eq!(receipts.len(), 2);
    let acts = &receipts[0].actions;
    assert_eq!(receipts[0].receiver_id, usdc_near(), "fee and swap are paid through the USDC token only");
    assert_eq!(acts.len(), 4, "swap registration + transfer + fee registration + fee transfer, one receipt");
    let (method, args, deposit, _) = call_of(&acts[2]);
    assert_eq!(method, "storage_deposit");
    assert_eq!(args, json!({ "account_id": fee_account(), "registration_only": true }));
    assert_eq!(deposit, FT_STORAGE_DEPOSIT);
    let (method, args, deposit, _) = call_of(&acts[3]);
    assert_eq!(method, "ft_transfer");
    assert_eq!(args, json!({ "receiver_id": fee_account(), "amount": "2000" }), "10 bps of 2 USDC = 0.002 USDC");
    assert_eq!(deposit, ONE_YOCTO);
    let (_, swap_args, _, _) = call_of(&acts[1]);
    assert_eq!(swap_args, json!({ "receiver_id": DEPOSIT_ADDRESS, "amount": "2000000" }), "the swap amount is not reduced by the fee");
    assert_eq!(e["data"][0]["fee"], "2000");
    assert_eq!(e["data"][0]["fee_account"], fee_account().as_str());
}

#[test]
fn zero_fee_bps_charges_nothing_and_adds_no_calls() {
    let (receipts, e) = fee_bridge_receipts(0);
    assert_eq!(receipts[0].actions.len(), 2);
    assert_eq!(e["data"][0]["fee"], "0");
}

#[test]
fn the_service_fee_is_rounded_down_and_never_overflows() {
    assert_eq!(service_fee(1_999_999, 33), Some(6_599), "1_999_999 * 33 / 10_000 = 6599.9967 rounds down");
    assert_eq!(service_fee(9_999, 1), Some(0), "below one unit rounds to zero");
    assert_eq!(service_fee(100_000, 10), Some(100), "the 0.1 USDC bridge minimum at the default rate");
    assert_eq!(service_fee(u128::MAX, 50), None, "overflow is reported, not wrapped");
    let (receipts, e) = fee_bridge_receipts(33);
    assert_eq!(call_of(&receipts[0].actions[3]).1["amount"], "6600", "2_000_000 * 33 / 10_000 = 6600 in the batch");
    assert_eq!(e["data"][0]["fee"], "6600");
}

#[test]
fn the_fee_rate_is_capped_at_50_bps_by_the_contract() {
    set_env(policy_account(), T0);
    new_policy_with_fee(BORROWER, &bridge_pk(), MAX_FEE_BPS);
    for bad in [MAX_FEE_BPS + 1, 100, 10_000, u32::MAX] {
        set_env(policy_account(), T0);
        let msg = panic_message(|| {
            new_policy_with_fee(BORROWER, &bridge_pk(), bad);
        });
        assert!(msg.starts_with("ERR_FEE_ABOVE_CAP_BPS"), "{bad}: {msg}");
    }
}

#[test]
#[should_panic(expected = "ERR_FEE_ACCOUNT_IS_POLICY")]
fn the_fee_account_cannot_be_the_policy_itself() {
    set_env(policy_account(), T0);
    Policy::new(
        owner(), agent(), BORROWER.into(), 8453, POOL.into(), USDC.into(), usdc_near(), DEST_ASSET.into(),
        bridge_pk(), mpc(), "p".into(), limits(), policy_account(), 10,
    );
}

#[test]
fn the_fee_rate_and_account_are_in_get_config_and_cannot_be_changed() {
    set_env(policy_account(), T0);
    let p = new_policy_with_fee(BORROWER, &bridge_pk(), 10);
    let c = p.get_config();
    assert_eq!((c.fee_bps, c.fee_account), (10, fee_account()));
    let src = include_str!("lib.rs");
    assert!(!src.contains("pub fn set_fee"), "there is no setter for the fee");
}

#[test]
fn a_failed_bridge_with_a_fee_restores_the_budget_like_one_without() {
    set_env(policy_account(), T0);
    let mut p = new_policy_with_fee(BORROWER, &bridge_pk(), 10);
    activate_with(&mut p, mpc_key().verifying_key());
    let id = fund(&mut p, T0, &valid_quote(T0));
    assert_eq!(p.bridge_budget.spent_today, 2 * USDC_1);
    set_env_with_result(T0, PromiseResult::Failed);
    let _ = p.on_bridge_funded(id);
    assert_eq!(p.bridge_budget.spent_today, 0, "the atomic batch moved nothing, fee included");
}

#[test]
fn failed_bridge_transfer_rolls_back_bridge_budget_and_fails_the_transaction() {
    let mut p = new_policy();
    let first = fund(&mut p, T0, &quote_for(USDC_1, T0));
    bridge_succeeds(&mut p, first, T0);
    let q = quote_for(2 * USDC_1, T0 + 700);
    let second = fund(&mut p, T0 + 700, &q);
    set_env_with_result(T0 + 701, PromiseResult::Failed);
    expect_failed(p.on_bridge_funded(second));
    let s = p.get_status();
    assert_eq!(s.bridge_spent_today, U128(USDC_1), "only the failed amount is restored");
    assert_eq!(s.last_bridge_at, U64(T0), "cooldown back to the previous bridge");
    assert_eq!(s.bridge_count, 1);
    assert_eq!(s.last_bridge.unwrap().bridge_id, first, "last_bridge still the funded one");
    assert!(p.pending_bridges.get(&second).is_none());
    let e = event(&get_logs()[0]);
    assert_eq!(e["event"], "bridge_failed");
    assert_eq!(e["data"][0]["reason"], "ERR_BRIDGE_TRANSFER_FAILED");
    assert_eq!(call_of(&get_created_receipts()[0].actions[0]).0, "fail_bridge");
    // the quote stays used
    let msg = panic_message(|| {
        fund(&mut p, T0 + 702, &q);
    });
    assert_eq!(msg, "ERR_QUOTE_ALREADY_USED");
}

#[test]
#[should_panic(expected = "ERR_BRIDGE_FAILED: bridge 2 not funded (USDC transfer failed); budget restored")]
fn fail_bridge_makes_the_transaction_fail() {
    let p = new_policy();
    set_env(policy_account(), T0);
    p.fail_bridge(2);
}

#[test]
fn successful_bridge_records_last_bridge() {
    let mut p = new_policy();
    let id = fund(&mut p, T0, &valid_quote(T0));
    let s = quote_string(&valid_quote(T0));
    let funded = bridge_succeeds(&mut p, id, T0 + 5);
    assert_eq!(
        funded,
        BridgeFunded {
            bridge_id: id,
            amount_in: U128(2 * USDC_1),
            min_amount_out: U128(1_990_000),
            deposit_address: DEPOSIT_ADDRESS.into(),
            quote_hash: hex::encode(env::sha256_array(s.as_bytes())),
        }
    );
    assert_eq!(
        p.get_status().last_bridge,
        Some(LastBridgeView {
            bridge_id: id,
            amount_in: U128(2 * USDC_1),
            min_amount_out: U128(1_990_000),
            deposit_address: DEPOSIT_ADDRESS.into(),
            funded_at: U64(T0 + 5),
        })
    );
    let e = event(&get_logs()[0]);
    assert_eq!(e["event"], "bridge_funded");
    assert_eq!(e["data"][0]["bridge_id"], id);
}

#[test]
#[should_panic(expected = "ERR_UNKNOWN_BRIDGE")]
fn bridge_callback_cannot_be_delivered_twice() {
    let mut p = new_policy();
    let id = fund(&mut p, T0, &valid_quote(T0));
    bridge_succeeds(&mut p, id, T0);
    bridge_succeeds(&mut p, id, T0);
}

// ------------------------------------------------------------------ close

fn paused_policy() -> Policy {
    let mut p = new_policy();
    set_env(owner(), T0);
    p.pause();
    p
}

fn close_callback(p: &Policy, now: u64, result: PromiseResult) -> Promise {
    set_env_with_result(now, result);
    p.on_close_balance()
}

#[test]
fn close_reads_the_usdc_balance_then_deletes_the_account_to_the_owner() {
    let p = &mut paused_policy();
    set_env_yocto(owner(), T0);
    let _ = p.close();
    let receipts = get_created_receipts();
    assert_eq!(receipts[0].receiver_id, usdc_near());
    let (method, args, deposit, gas) = call_of(&receipts[0].actions[0]);
    assert_eq!(method, "ft_balance_of");
    assert_eq!(args, json!({ "account_id": "policy.near" }));
    assert_eq!(deposit, ZERO);
    assert_eq!(gas, CLOSE_VIEW_GAS);
    assert_eq!(receipts[1].receiver_id, policy_account());
    let (method, args, _, gas) = call_of(&receipts[1].actions[0]);
    assert_eq!(method, "on_close_balance");
    assert_eq!(args, Value::Null);
    assert_eq!(gas, CLOSE_CALLBACK_GAS);

    let _ = close_callback(p, T0, PromiseResult::Successful(b"\"0\"".to_vec()));
    let receipts = get_created_receipts();
    assert_eq!(receipts.len(), 1);
    assert_eq!(receipts[0].receiver_id, policy_account());
    assert_eq!(receipts[0].actions.len(), 1);
    match &receipts[0].actions[0] {
        MockAction::DeleteAccount { beneficiary_id, .. } => assert_eq!(beneficiary_id, &owner()),
        other => panic!("unexpected action {other:?}"),
    }
    assert!(get_logs().is_empty(), "no event: DeleteAccount may still fail, so nothing may announce a close");
}

#[test]
fn only_owner_with_one_yocto_can_close() {
    let mut p = paused_policy();
    for who in [agent(), stranger()] {
        set_env_yocto(who, T0);
        assert_eq!(panic_message(|| drop(p.close())), "ERR_NOT_OWNER");
    }
    set_env(owner(), T0);
    assert_eq!(panic_message(|| drop(p.close())), "Requires attached deposit of exactly 1 yoctoNEAR");
}

#[test]
fn close_requires_a_paused_policy() {
    let mut p = new_policy();
    set_env_yocto(owner(), T0);
    assert!(panic_message(|| drop(p.close())).starts_with("ERR_NOT_PAUSED"));
}

#[test]
fn close_waits_one_hour_after_a_rescue_approve_or_bridge_request() {
    type Request = fn(&mut Policy);
    let requests: [Request; 3] = [
        |p| {
            rescue_at(p, T0, USDC_1);
        },
        |p| {
            set_env(agent(), T0);
            let _ = p.approve_pool(U64(0), U128(GWEI / 10), U128(0), U128(100_000));
        },
        |p| {
            fund(p, T0, &valid_quote(T0));
        },
    ];
    for request in requests {
        let mut p = new_policy();
        request(&mut p);
        set_env(owner(), T0);
        p.pause();
        set_env_yocto(owner(), T0 + CLOSE_QUIET_SECS - 1);
        assert!(panic_message(|| drop(p.close())).starts_with("ERR_CLOSE_TOO_SOON"));
        set_env_yocto(owner(), T0 + CLOSE_QUIET_SECS);
        let _ = p.close();
    }
}

#[test]
fn a_failed_signature_does_not_shorten_the_close_wait() {
    let mut p = new_policy();
    let id = rescue_at(&mut p, T0, USDC_1);
    set_env_with_result(T0 + 5, PromiseResult::Failed);
    expect_failed(p.on_signed(id));
    set_env(owner(), T0 + 10);
    p.pause();
    set_env_yocto(owner(), T0 + CLOSE_QUIET_SECS - 1);
    assert!(panic_message(|| drop(p.close())).starts_with("ERR_CLOSE_TOO_SOON"));
}

#[test]
fn close_is_refused_while_usdc_is_left_but_dust_cannot_block_it() {
    let p = paused_policy();
    let left = format!("\"{}\"", CLOSE_MAX_USDC_DUST + 1).into_bytes();
    let msg = panic_message(|| drop(close_callback(&p, T0, PromiseResult::Successful(left))));
    assert!(msg.starts_with("ERR_CLOSE_USDC_LEFT"));
    let dust = format!("\"{CLOSE_MAX_USDC_DUST}\"").into_bytes();
    let _ = close_callback(&p, T0, PromiseResult::Successful(dust));
    assert!(matches!(get_created_receipts()[0].actions[0], MockAction::DeleteAccount { .. }));
}

#[test]
fn close_is_refused_when_the_balance_cannot_be_read() {
    let p = paused_policy();
    for result in [PromiseResult::Failed, PromiseResult::Successful(b"{}".to_vec()), PromiseResult::Successful(vec![b'9'; 65])] {
        let msg = panic_message(|| drop(close_callback(&p, T0, result)));
        assert!(msg.starts_with("ERR_CLOSE_FAILED"), "{msg}");
        assert!(get_created_receipts().is_empty());
    }
}

#[test]
fn close_callback_rechecks_pause_and_wait() {
    let mut p = paused_policy();
    set_env_yocto(owner(), T0);
    p.unpause();
    let msg = panic_message(|| drop(close_callback(&p, T0, PromiseResult::Successful(b"\"0\"".to_vec()))));
    assert!(msg.starts_with("ERR_NOT_PAUSED"));
}

#[test]
fn close_callback_is_private_and_takes_no_beneficiary() {
    let src = include_str!("lib.rs");
    let at = src.find("pub fn on_close_balance(&self) -> Promise").expect("signature changed");
    assert!(src[..at].trim_end().ends_with("#[private]"));
    assert!(src.contains("pub fn close(&mut self) -> Promise"));
    assert_eq!(src.matches("delete_account(").count(), 1);
    assert!(src.contains(".delete_account(self.owner.clone())"));
    assert!(!src.contains("deploy_contract("));
}

#[test]
fn close_with_too_little_gas_is_rejected() {
    let mut p = paused_policy();
    let mut ctx = builder(owner(), T0, ONE_YOCTO).build();
    ctx.prepaid_gas = Gas::from_tgas(30);
    testing_env!(ctx);
    assert_eq!(panic_message(|| drop(p.close())), "ERR_NOT_ENOUGH_GAS: attach 100 TGas to close");
}
