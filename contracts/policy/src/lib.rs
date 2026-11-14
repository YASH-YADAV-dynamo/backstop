//! Backstop policy contract (v2).
//!
//! Holds the owner's rescue USDC on NEAR and the owner's limits, and is the only path to a Chain
//! Signatures signature for the Base address derived from this account. It pays 1Click only for a
//! quote signed by 1Click whose recipient is that derived address and whose refund goes back here,
//! and it builds every Base transaction it signs itself: `Pool.repay(usdc, amount, 2, on_behalf_of)`
//! and `USDC.approve(pool, daily_cap)`. The account is meant to have no access keys.

pub mod bridge;
pub mod evm;
pub mod limits;
pub mod time;

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{
    assert_one_yocto, env, near, require, AccountId, BorshStorageKey, Gas, GasWeight, NearToken, PanicOnDefault,
    Promise, PromiseError, PromiseOrValue,
};
use omni_transaction::evm::types::Address;

pub use crate::bridge::{
    MAX_BRIDGE_LOSS_BPS, MAX_QUOTE_AGE_SECS, MAX_QUOTE_FUTURE_SECS, MAX_QUOTE_LEN, MIN_BRIDGE_AMOUNT,
    MIN_QUOTE_DEADLINE_MARGIN_SECS,
};
use crate::bridge::{check_quote, decode_ed25519, encode_ed25519, verify_quote_signature, QuoteExpectations};
use crate::evm::{EvmCall, RawSignature};
use crate::limits::{check_bridge, check_rescue, check_tx_params, utc_day_start, Budget, Limits, RescueRequest};

/// Minimum gas for `rescue` and `approve_pool` (callers attach 300 TGas).
pub const MIN_RESCUE_GAS: Gas = Gas::from_tgas(250);
/// Minimum gas for `fund_bridge` (the agent attaches 150 TGas): quote checks plus up to four token calls.
pub const MIN_BRIDGE_GAS: Gas = Gas::from_tgas(120);
/// Hard cap on the service fee: 0.50% of a bridged amount, whatever the operator passes to `new`.
pub const MAX_FEE_BPS: u32 = 50;
/// Minimum gas for `withdraw` (the web attaches 50 TGas).
pub const MIN_WITHDRAW_GAS: Gas = Gas::from_tgas(40);
/// Minimum gas for `activate` (the web / factory attach 50 TGas).
pub const MIN_ACTIVATE_GAS: Gas = Gas::from_tgas(30);
pub const FT_STORAGE_GAS: Gas = Gas::from_tgas(10);
pub const FT_TRANSFER_GAS: Gas = Gas::from_tgas(15);
pub const BRIDGE_CALLBACK_GAS: Gas = Gas::from_tgas(15);
/// Static gas for the withdraw callback (outbound calls get the remaining gas by weight; audit F1).
pub const WITHDRAW_CALLBACK_GAS: Gas = Gas::from_tgas(10);
pub const DERIVE_VIEW_GAS: Gas = Gas::from_tgas(10);
pub const DERIVE_CALLBACK_GAS: Gas = Gas::from_tgas(10);
/// Static gas for `v1.signer.sign`; it also receives all unused gas (weight 1).
pub const SIGN_STATIC_GAS: Gas = Gas::from_tgas(50);
/// Gas reserved for `on_signed` (parse, ecrecover, RLP, and a possible `fail_rescue` call).
pub const CALLBACK_GAS: Gas = Gas::from_tgas(20);
/// Gas for `fail_rescue` / `fail_bridge`, scheduled from a callback that failed.
pub const FAIL_GAS: Gas = Gas::from_tgas(5);
/// USDC on NEAR: storage_balance_bounds min == max == 0.00125 NEAR (read live 2026-11-13).
pub const FT_STORAGE_DEPOSIT: NearToken = NearToken::from_yoctonear(1_250_000_000_000_000_000_000);
/// Deposit `v1.signer.sign` requires (1 yoctoNEAR, as chainsig.js sends).
pub const SIGN_DEPOSIT: NearToken = NearToken::from_yoctonear(1);
/// `approve_pool` can be signed at most once per hour.
pub const APPROVE_MIN_INTERVAL_SECS: u64 = 3_600;
/// `withdraw_near` always leaves storage cost plus this much NEAR in the account.
pub const MIN_NEAR_RESERVE: NearToken = NearToken::from_millinear(200);
pub const MIN_CLOSE_GAS: Gas = Gas::from_tgas(40);
pub const CLOSE_VIEW_GAS: Gas = Gas::from_tgas(5);
/// Static gas for the close callback (the balance view gets the remaining gas by weight).
pub const CLOSE_CALLBACK_GAS: Gas = Gas::from_tgas(15);
/// `close` needs this much time since the last sign or bridge request: longer than an MPC
/// signature, a bridge callback and the agent's 30-minute quote deadline (a 1Click refund).
pub const CLOSE_QUIET_SECS: u64 = 3_600;
/// `close` tolerates less than 0.01 USDC so that nobody can block it by sending dust.
pub const CLOSE_MAX_USDC_DUST: u128 = 9_999;
/// Upper bound on the `ft_balance_of` response we are willing to read.
const MAX_BALANCE_RESPONSE_LEN: usize = 64;
/// secp256k1 in the MPC contract.
pub const SECP256K1_DOMAIN_ID: u64 = 0;
/// The only failure where MPC produced no signature, so the only one that restores the budget.
pub const ERR_MPC_SIGN_FAILED: &str = "ERR_MPC_SIGN_FAILED";
/// Upper bound on the MPC response we are willing to read.
const MAX_SIGN_RESPONSE_LEN: usize = 2048;
/// Upper bound on the `derived_public_key` response we are willing to read.
const MAX_DERIVE_RESPONSE_LEN: usize = 256;

pub const CONTRACT_VERSION: &str = "2.1.0";
const EVENT_STANDARD: &str = "backstop";
const EVENT_VERSION: &str = "2.0.0";

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Pending,
    PendingBridges,
    UsedQuotes,
}

/// Which Base transaction a signature request is for.
#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TxKind {
    Repay,
    ApprovePool,
}

impl TxKind {
    pub fn as_str(self) -> &'static str {
        match self {
            TxKind::Repay => "repay",
            TxKind::ApprovePool => "approve_pool",
        }
    }
}

/// Everything needed to rebuild the exact unsigned tx in the callback, and to roll back exactly.
/// A snapshot: a later `set_on_behalf_of` / `set_limits` cannot change what an in-flight
/// signature is for.
#[near(serializers = [borsh])]
pub struct PendingSign {
    pub kind: TxKind,
    pub amount: u128,
    pub to: Address,
    pub value: u128,
    pub data: Vec<u8>,
    pub evm_nonce: u64,
    pub max_fee_per_gas: u128,
    pub max_priority_fee_per_gas: u128,
    pub gas_limit: u128,
    pub payload_hash: [u8; 32],
    pub day_start: u64,
    pub requested_at: u64,
    pub prior_last_rescue_at: Option<u64>,
    pub prior_last_approve_at: Option<u64>,
}

/// A bridge whose USDC transfer to the 1Click deposit address has not resolved yet.
#[near(serializers = [borsh])]
pub struct PendingBridge {
    pub amount_in: u128,
    pub min_amount_out: u128,
    pub deposit_address: AccountId,
    pub quote_hash: [u8; 32],
    pub day_start: u64,
    pub requested_at: u64,
    pub prior_last_bridge_at: Option<u64>,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct LastBridge {
    pub bridge_id: u64,
    pub amount_in: u128,
    pub min_amount_out: u128,
    pub deposit_address: AccountId,
    pub funded_at: u64,
}

#[near(serializers = [json])]
#[derive(Debug, PartialEq, Eq)]
pub struct RescueSigned {
    pub rescue_id: u64,
    pub kind: TxKind,
    pub amount: U128,
    /// 0x + keccak256(signed_tx): the Base tx hash.
    pub tx_hash: String,
    /// 0x + raw EIP-1559 tx for eth_sendRawTransaction.
    pub signed_tx: String,
}

#[near(serializers = [json])]
#[derive(Debug, PartialEq, Eq)]
pub struct BridgeFunded {
    pub bridge_id: u64,
    pub amount_in: U128,
    pub min_amount_out: U128,
    pub deposit_address: String,
    /// sha256 of the quote string, 64 hex chars.
    pub quote_hash: String,
}

#[near(serializers = [json])]
pub struct LimitsView {
    #[serde(flatten)]
    pub limits: Limits,
    pub paused: bool,
}

#[near(serializers = [json])]
#[derive(Debug, PartialEq, Eq)]
pub struct LastBridgeView {
    pub bridge_id: u64,
    pub amount_in: U128,
    pub min_amount_out: U128,
    pub deposit_address: String,
    pub funded_at: U64,
}

#[near(serializers = [json])]
#[derive(Debug, PartialEq, Eq)]
pub struct StatusView {
    pub spent_today: U128,
    pub day_start: U64,
    pub last_rescue_at: U64,
    pub rescue_count: u64,
    pub remaining_today: U128,
    pub cooldown_ends_at: U64,
    pub bridge_spent_today: U128,
    pub bridge_remaining_today: U128,
    pub last_bridge_at: U64,
    pub bridge_cooldown_ends_at: U64,
    pub bridge_count: u64,
    pub last_approve_at: U64,
    pub last_bridge: Option<LastBridgeView>,
}

#[near(serializers = [json])]
pub struct ConfigView {
    pub version: String,
    pub owner: AccountId,
    pub agent: AccountId,
    /// `null` until `activate` derived it from `v1.signer`.
    pub base_address: Option<String>,
    pub on_behalf_of: String,
    pub chain_id: u64,
    pub aave_pool: String,
    pub usdc_base: String,
    pub usdc_near: AccountId,
    pub bridge_dest_asset: String,
    pub bridge_signer_pk: String,
    pub mpc_contract: AccountId,
    pub derivation_path: String,
    /// NEAR account that receives the service fee in NEAR USDC on every bridge.
    pub fee_account: AccountId,
    /// Fee in basis points of each bridged amount (0 = no fee), at most `MAX_FEE_BPS`. Fixed at creation.
    pub fee_bps: u32,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Policy {
    owner: AccountId,
    agent: AccountId,
    /// The derived Base address; `None` until `activate`.
    base_address: Option<Address>,
    /// The borrower: the user's own EVM address that holds the Aave loan.
    on_behalf_of: Address,
    chain_id: u64,
    aave_pool: Address,
    usdc_base: Address,
    usdc_near: AccountId,
    bridge_dest_asset: String,
    bridge_signer_pk: [u8; 32],
    mpc_contract: AccountId,
    derivation_path: String,
    limits: Limits,
    /// Service fee recipient and rate, fixed in `new` (no setter exists).
    fee_account: AccountId,
    fee_bps: u32,
    paused: bool,
    budget: Budget,
    bridge_budget: Budget,
    /// Repays signed or in flight (a failed signature decrements it again).
    rescue_count: u64,
    /// Bridges funded or in flight (a failed transfer decrements it again).
    bridge_count: u64,
    /// Monotonic id source for every MPC sign request; never reused.
    next_rescue_id: u64,
    next_bridge_id: u64,
    last_approve_at: Option<u64>,
    last_bridge: Option<LastBridge>,
    /// Time of the latest sign or bridge request; never rolled back. `close` waits on it.
    last_request_at: u64,
    pending: LookupMap<u64, PendingSign>,
    pending_bridges: LookupMap<u64, PendingBridge>,
    /// sha256 of every quote ever accepted by `fund_bridge`.
    used_quotes: LookupSet<[u8; 32]>,
}

/// Service fee for a bridged amount: `amount * bps / 10_000`, rounded down; `None` on overflow.
/// It is charged on top of the swap amount and is NOT counted against `daily_cap` (docs/SECURITY.md).
pub fn service_fee(amount: u128, fee_bps: u32) -> Option<u128> {
    amount.checked_mul(u128::from(fee_bps)).map(|x| x / 10_000)
}

fn now_secs() -> u64 {
    env::block_timestamp() / 1_000_000_000
}

/// NEP-297 event log with a fixed key order: standard, version, event, data.
fn emit(event: &str, data: Value) {
    env::log_str(&format!(
        r#"EVENT_JSON:{{"standard":"{EVENT_STANDARD}","version":"{EVENT_VERSION}","event":"{event}","data":[{data}]}}"#
    ));
}

fn parse_address_or_panic(field: &str, value: &str) -> Address {
    evm::parse_evm_address(value).unwrap_or_else(|e| env::panic_str(&format!("{e}: {field}")))
}

fn parse_signer_pk_or_panic(value: &str) -> [u8; 32] {
    decode_ed25519(value).unwrap_or_else(|| {
        env::panic_str("ERR_BRIDGE_SIGNER_FORMAT: expected ed25519:<base58 of 32 bytes>")
    })
}

fn require_gas(min: Gas, msg: &str) {
    require!(env::prepaid_gas() >= min, msg);
}

#[near]
impl Policy {
    /// Not `#[private]`: the factory or deployer calls it in the same transaction that deploys the
    /// code. near-sdk refuses a second call once state exists.
    #[init]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        owner: AccountId,
        agent: AccountId,
        on_behalf_of: String,
        chain_id: u64,
        aave_pool: String,
        usdc_base: String,
        usdc_near: AccountId,
        bridge_dest_asset: String,
        bridge_signer_pk: String,
        mpc_contract: AccountId,
        derivation_path: String,
        limits: Limits,
        fee_account: AccountId,
        fee_bps: u32,
    ) -> Self {
        require!(chain_id != 0, "ERR_CHAIN_ID_ZERO");
        require!(fee_bps <= MAX_FEE_BPS, "ERR_FEE_ABOVE_CAP_BPS: the service fee is at most 50 bps (0.50%)");
        require!(fee_account != env::current_account_id(), "ERR_FEE_ACCOUNT_IS_POLICY");
        require!(!derivation_path.is_empty(), "ERR_DERIVATION_PATH_EMPTY");
        require!(!bridge_dest_asset.is_empty(), "ERR_BRIDGE_DEST_ASSET_EMPTY");
        if let Err(e) = limits.validate() {
            env::panic_str(e);
        }
        let day_start = utc_day_start(now_secs());
        Self {
            owner,
            agent,
            base_address: None,
            on_behalf_of: parse_address_or_panic("on_behalf_of", &on_behalf_of),
            chain_id,
            aave_pool: parse_address_or_panic("aave_pool", &aave_pool),
            usdc_base: parse_address_or_panic("usdc_base", &usdc_base),
            usdc_near,
            bridge_dest_asset,
            bridge_signer_pk: parse_signer_pk_or_panic(&bridge_signer_pk),
            mpc_contract,
            derivation_path,
            limits,
            fee_account,
            fee_bps,
            paused: false,
            budget: Budget { spent_today: 0, day_start, last_rescue_at: None },
            bridge_budget: Budget { spent_today: 0, day_start, last_rescue_at: None },
            rescue_count: 0,
            bridge_count: 0,
            next_rescue_id: 1,
            next_bridge_id: 1,
            last_approve_at: None,
            last_bridge: None,
            pending: LookupMap::new(StorageKey::Pending),
            last_request_at: 0,
            pending_bridges: LookupMap::new(StorageKey::PendingBridges),
            used_quotes: LookupSet::new(StorageKey::UsedQuotes),
        }
    }

    // ---------------------------------------------------------------- activation

    /// Asks `v1.signer` for the key derived from (this account, derivation path) and stores its
    /// Ethereum address as `base_address`. Anyone may call it; it can only ever store that address.
    pub fn activate(&mut self) -> Promise {
        require!(self.base_address.is_none(), "ERR_ALREADY_ACTIVATED");
        require_gas(MIN_ACTIVATE_GAS, "ERR_NOT_ENOUGH_GAS: attach 50 TGas to activate");
        let args = json!({
            "path": self.derivation_path,
            "predecessor": env::current_account_id(),
            "domain_id": SECP256K1_DOMAIN_ID,
        });
        Promise::new(self.mpc_contract.clone())
            .function_call_weight("derived_public_key", args.to_string().into_bytes(), NearToken::from_yoctonear(0), DERIVE_VIEW_GAS, GasWeight(1))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(DERIVE_CALLBACK_GAS)
                    .with_unused_gas_weight(0)
                    .on_derived_key(),
            )
    }

    /// Callback of `activate`. Panics (state unchanged, `activate` can be retried) on any failure.
    #[private]
    pub fn on_derived_key(&mut self) -> String {
        require!(self.base_address.is_none(), "ERR_ALREADY_ACTIVATED");
        let bytes = env::promise_result_checked(0, MAX_DERIVE_RESPONSE_LEN)
            .unwrap_or_else(|_| env::panic_str("ERR_DERIVE_FAILED: derived_public_key call failed; call activate again"));
        let address = evm::parse_derived_key(&bytes).unwrap_or_else(|e| env::panic_str(e));
        let formatted = evm::format_evm_address(&address);
        self.base_address = Some(address);
        emit("activated", json!({ "base_address": formatted }));
        formatted
    }

    // ---------------------------------------------------------------- owner

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "ERR_NOT_OWNER");
    }

    /// Owner with exactly 1 yoctoNEAR: only a full-access key (a wallet prompt) can do that.
    fn assert_owner_one_yocto(&self) {
        self.assert_owner();
        assert_one_yocto();
    }

    #[payable]
    pub fn set_limits(&mut self, limits: Limits) {
        self.assert_owner_one_yocto();
        if let Err(e) = limits.validate() {
            env::panic_str(e);
        }
        emit("limits_updated", serde_json::to_value(&limits).unwrap_or(Value::Null));
        self.limits = limits;
    }

    #[payable]
    pub fn set_agent(&mut self, agent: AccountId) {
        self.assert_owner_one_yocto();
        emit("agent_updated", json!({ "old_agent": self.agent, "new_agent": agent }));
        self.agent = agent;
    }

    #[payable]
    pub fn set_on_behalf_of(&mut self, on_behalf_of: String) {
        self.assert_owner_one_yocto();
        let new = parse_address_or_panic("on_behalf_of", &on_behalf_of);
        emit(
            "borrower_updated",
            json!({ "old": evm::format_evm_address(&self.on_behalf_of), "new": evm::format_evm_address(&new) }),
        );
        self.on_behalf_of = new;
    }

    #[payable]
    pub fn set_bridge_signer(&mut self, public_key: String) {
        self.assert_owner_one_yocto();
        let new = parse_signer_pk_or_panic(&public_key);
        emit(
            "bridge_signer_updated",
            json!({ "old": encode_ed25519(&self.bridge_signer_pk), "new": encode_ed25519(&new) }),
        );
        self.bridge_signer_pk = new;
    }

    /// No deposit on purpose: pausing only makes things safer and must be as easy as possible.
    pub fn pause(&mut self) {
        self.assert_owner();
        self.paused = true;
        emit("paused", json!({ "by": self.owner }));
    }

    #[payable]
    pub fn unpause(&mut self) {
        self.assert_owner_one_yocto();
        self.paused = false;
        emit("unpaused", json!({ "by": self.owner }));
    }

    /// Sends `amount` USDC from the policy to the owner. There is no recipient parameter.
    #[payable]
    pub fn withdraw(&mut self, amount: U128) -> Promise {
        self.assert_owner_one_yocto();
        require_gas(MIN_WITHDRAW_GAS, "ERR_NOT_ENOUGH_GAS: attach 50 TGas to withdraw");
        require!(amount.0 > 0, "ERR_ZERO_AMOUNT");
        let args = json!({ "receiver_id": self.owner, "amount": amount, "memo": "backstop withdraw" });
        Promise::new(self.usdc_near.clone())
            .function_call_weight("ft_transfer", args.to_string().into_bytes(), NearToken::from_yoctonear(1), FT_TRANSFER_GAS, GasWeight(1))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(WITHDRAW_CALLBACK_GAS)
                    .with_unused_gas_weight(0)
                    .on_withdrawn(amount),
            )
    }

    #[private]
    pub fn on_withdrawn(&mut self, amount: U128) -> U128 {
        if matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed)) {
            env::panic_str(
                "ERR_WITHDRAW_FAILED: the USDC transfer failed; check the policy's USDC balance and that the owner is registered on the USDC token",
            );
        }
        emit("withdrawn", json!({ "to": self.owner, "amount": amount }));
        amount
    }

    /// Sends `amount` yoctoNEAR to the owner, keeping storage cost plus `MIN_NEAR_RESERVE`.
    #[payable]
    pub fn withdraw_near(&mut self, amount: U128) -> Promise {
        self.assert_owner_one_yocto();
        require!(amount.0 > 0, "ERR_ZERO_AMOUNT");
        let storage = env::storage_byte_cost().saturating_mul(u128::from(env::storage_usage()));
        let keep = storage.saturating_add(MIN_NEAR_RESERVE);
        let left = env::account_balance().checked_sub(NearToken::from_yoctonear(amount.0));
        require!(
            left.is_some_and(|l| l >= keep),
            "ERR_NEAR_RESERVE: the policy must keep its storage cost plus 0.2 NEAR"
        );
        emit("near_withdrawn", json!({ "to": self.owner, "amount": amount }));
        Promise::new(self.owner.clone()).transfer(NearToken::from_yoctonear(amount.0))
    }

    /// Deletes the policy account and sends all its NEAR (storage stake included) to the owner.
    /// Only while paused, at least `CLOSE_QUIET_SECS` after the last sign or bridge request, and
    /// with less than 0.01 USDC left. There is no beneficiary parameter.
    #[payable]
    pub fn close(&mut self) -> Promise {
        self.assert_owner_one_yocto();
        require_gas(MIN_CLOSE_GAS, "ERR_NOT_ENOUGH_GAS: attach 100 TGas to close");
        self.assert_closable();
        let current = env::current_account_id();
        let args = json!({ "account_id": current });
        Promise::new(self.usdc_near.clone())
            .function_call_weight("ft_balance_of", args.to_string().into_bytes(), NearToken::from_yoctonear(0), CLOSE_VIEW_GAS, GasWeight(1))
            .then(Self::ext(current).with_static_gas(CLOSE_CALLBACK_GAS).with_unused_gas_weight(0).on_close_balance())
    }

    /// Callback of `close`. Panics (nothing changes, `close` can be retried) unless every
    /// condition still holds and the token reports less than 0.01 USDC.
    #[private]
    pub fn on_close_balance(&self) -> Promise {
        self.assert_closable();
        let bytes = env::promise_result_checked(0, MAX_BALANCE_RESPONSE_LEN)
            .unwrap_or_else(|_| env::panic_str("ERR_CLOSE_FAILED: could not read the policy's USDC balance; call close again"));
        let balance: U128 = serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| env::panic_str("ERR_CLOSE_FAILED: the USDC balance is not a number; call close again"));
        require!(balance.0 <= CLOSE_MAX_USDC_DUST, "ERR_CLOSE_USDC_LEFT: withdraw the policy's USDC first");
        // No event here: DeleteAccount can still fail (state above 10 KB), and an event would then
        // announce a closing that never happened. The deletion itself is visible on chain.
        Promise::new(env::current_account_id()).delete_account(self.owner.clone())
    }

    // ---------------------------------------------------------------- deposits

    /// NEP-141 receiver. Keeps USDC (all of it belongs to the owner); refunds any other token.
    /// Never panics.
    #[allow(unused_variables)]
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        if env::predecessor_account_id() != self.usdc_near {
            return amount;
        }
        emit("deposit", json!({ "sender": sender_id, "amount": amount }));
        U128(0)
    }

    // ---------------------------------------------------------------- agent: bridge

    /// Pays a 1Click deposit address for a quote 1Click signed, after checking every routing field
    ///. The USDC can only arrive at the derived address or be refunded here.
    pub fn fund_bridge(&mut self, quote: String, signature: String) -> Promise {
        require!(env::predecessor_account_id() == self.agent, "ERR_NOT_AGENT");
        require_gas(MIN_BRIDGE_GAS, "ERR_NOT_ENOUGH_GAS: attach 150 TGas to fund_bridge");
        let recipient = self.activated_address();
        let quote_hash =
            verify_quote_signature(&quote, &signature, &self.bridge_signer_pk).unwrap_or_else(|e| env::panic_str(e));
        let now = now_secs();
        let current = env::current_account_id();
        let checked = check_quote(
            &quote,
            &QuoteExpectations {
                usdc_near: &self.usdc_near,
                dest_asset: &self.bridge_dest_asset,
                recipient: &recipient,
                refund_to: &current,
                now,
            },
        )
        .unwrap_or_else(|e| env::panic_str(e));
        require!(!self.used_quotes.contains(&quote_hash), "ERR_QUOTE_ALREADY_USED");
        let new_budget = check_bridge(&self.limits, self.paused, &self.bridge_budget, now, checked.amount_in)
            .unwrap_or_else(|e| env::panic_str(e));

        // Service fee on top of the swap amount (not part of the quote), rounded down.
        let fee = service_fee(checked.amount_in, self.fee_bps).unwrap_or_else(|| env::panic_str("ERR_FEE_OVERFLOW"));

        let bridge_id = self.next_bridge_id;
        self.next_bridge_id += 1;
        self.bridge_count += 1;
        let prior_last_bridge_at = self.bridge_budget.last_rescue_at;
        self.bridge_budget = new_budget;
        self.used_quotes.insert(quote_hash);
        self.last_request_at = now;
        self.pending_bridges.insert(
            bridge_id,
            PendingBridge {
                amount_in: checked.amount_in,
                min_amount_out: checked.min_amount_out,
                deposit_address: checked.deposit_address.clone(),
                quote_hash,
                day_start: self.bridge_budget.day_start,
                requested_at: now,
                prior_last_bridge_at,
            },
        );
        emit(
            "bridge_requested",
            json!({
                "bridge_id": bridge_id,
                "amount_in": U128(checked.amount_in),
                "min_amount_out": U128(checked.min_amount_out),
                "deposit_address": checked.deposit_address,
                "quote_hash": hex::encode(quote_hash),
                "fee": U128(fee),
                "fee_account": self.fee_account,
            }),
        );

        let storage_args = json!({ "account_id": checked.deposit_address, "registration_only": true });
        let transfer_args = json!({ "receiver_id": checked.deposit_address, "amount": U128(checked.amount_in) });
        let mut batch = Promise::new(self.usdc_near.clone())
            .function_call_weight("storage_deposit", storage_args.to_string().into_bytes(), FT_STORAGE_DEPOSIT, FT_STORAGE_GAS, GasWeight(1))
            .function_call_weight("ft_transfer", transfer_args.to_string().into_bytes(), NearToken::from_yoctonear(1), FT_TRANSFER_GAS, GasWeight(1));
        if fee > 0 {
            // Same atomic batch: if the fee cannot be paid, nothing moves. Registration refunds its
            // deposit when the fee account is already registered, so no setup step can break bridging.
            let fee_storage = json!({ "account_id": self.fee_account, "registration_only": true });
            let fee_transfer = json!({ "receiver_id": self.fee_account, "amount": U128(fee) });
            batch = batch
                .function_call_weight("storage_deposit", fee_storage.to_string().into_bytes(), FT_STORAGE_DEPOSIT, FT_STORAGE_GAS, GasWeight(1))
                .function_call_weight("ft_transfer", fee_transfer.to_string().into_bytes(), NearToken::from_yoctonear(1), FT_TRANSFER_GAS, GasWeight(1));
        }
        batch
            .then(
                Self::ext(current)
                    .with_static_gas(BRIDGE_CALLBACK_GAS)
                    .with_unused_gas_weight(0)
                    .on_bridge_funded(bridge_id),
            )
    }

    /// Callback of `fund_bridge`. The storage_deposit + ft_transfer batch is atomic, so a failure
    /// moved nothing and the bridge budget is restored; the quote stays used.
    #[private]
    pub fn on_bridge_funded(&mut self, bridge_id: u64) -> PromiseOrValue<BridgeFunded> {
        let p = self.pending_bridges.remove(&bridge_id).unwrap_or_else(|| env::panic_str("ERR_UNKNOWN_BRIDGE"));
        if matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed)) {
            if self.bridge_budget.day_start == p.day_start {
                self.bridge_budget.spent_today = self.bridge_budget.spent_today.saturating_sub(p.amount_in);
            }
            if self.bridge_budget.last_rescue_at == Some(p.requested_at) {
                self.bridge_budget.last_rescue_at = p.prior_last_bridge_at;
            }
            self.bridge_count = self.bridge_count.saturating_sub(1);
            emit(
                "bridge_failed",
                json!({ "bridge_id": bridge_id, "amount_in": U128(p.amount_in), "reason": "ERR_BRIDGE_TRANSFER_FAILED" }),
            );
            return PromiseOrValue::Promise(
                Self::ext(env::current_account_id())
                    .with_static_gas(FAIL_GAS)
                    .with_unused_gas_weight(0)
                    .fail_bridge(bridge_id),
            );
        }
        let now = now_secs();
        self.last_bridge = Some(LastBridge {
            bridge_id,
            amount_in: p.amount_in,
            min_amount_out: p.min_amount_out,
            deposit_address: p.deposit_address.clone(),
            funded_at: now,
        });
        let funded = BridgeFunded {
            bridge_id,
            amount_in: U128(p.amount_in),
            min_amount_out: U128(p.min_amount_out),
            deposit_address: p.deposit_address.to_string(),
            quote_hash: hex::encode(p.quote_hash),
        };
        emit("bridge_funded", serde_json::to_value(&funded).unwrap_or(Value::Null));
        PromiseOrValue::Value(funded)
    }

    /// Makes the `fund_bridge` transaction fail visibly after the rollback has been committed.
    #[private]
    pub fn fail_bridge(&self, bridge_id: u64) {
        env::panic_str(&format!("ERR_BRIDGE_FAILED: bridge {bridge_id} not funded (USDC transfer failed); budget restored"))
    }

    // ---------------------------------------------------------------- agent: Base transactions

    /// Checks the limits, reserves the budget, builds `repay(usdc, amount, 2, on_behalf_of)` and
    /// asks MPC to sign it.
    pub fn rescue(
        &mut self,
        amount: U128,
        evm_nonce: U64,
        max_fee_per_gas: U128,
        max_priority_fee_per_gas: U128,
        gas_limit: U128,
    ) -> Promise {
        require!(env::predecessor_account_id() == self.agent, "ERR_NOT_AGENT");
        require_gas(MIN_RESCUE_GAS, "ERR_NOT_ENOUGH_GAS: attach 300 TGas to rescue");
        self.activated_address();

        let now = now_secs();
        let req = RescueRequest {
            amount: amount.0,
            max_fee_per_gas: max_fee_per_gas.0,
            max_priority_fee_per_gas: max_priority_fee_per_gas.0,
            gas_limit: gas_limit.0,
        };
        let new_budget =
            check_rescue(&self.limits, self.paused, &self.budget, now, &req).unwrap_or_else(|e| env::panic_str(e));

        self.rescue_count += 1;
        let prior_last_rescue_at = self.budget.last_rescue_at;
        self.budget = new_budget;
        let call = EvmCall {
            chain_id: self.chain_id,
            nonce: evm_nonce.0,
            to: self.aave_pool,
            value: 0,
            data: evm::encode_repay(&self.usdc_base, amount.0, &self.on_behalf_of),
            max_fee_per_gas: req.max_fee_per_gas,
            max_priority_fee_per_gas: req.max_priority_fee_per_gas,
            gas_limit: req.gas_limit,
        };
        self.request_signature(TxKind::Repay, amount.0, call, now, prior_last_rescue_at)
    }

    /// Signs `USDC.approve(aave_pool, daily_cap)` for the derived address. Agent (no deposit, not
    /// paused) or owner (1 yoctoNEAR, any pause state); at most once per `APPROVE_MIN_INTERVAL_SECS`.
    #[payable]
    pub fn approve_pool(
        &mut self,
        evm_nonce: U64,
        max_fee_per_gas: U128,
        max_priority_fee_per_gas: U128,
        gas_limit: U128,
    ) -> Promise {
        let caller = env::predecessor_account_id();
        let deposit = env::attached_deposit();
        if caller == self.agent && deposit.is_zero() {
            require!(!self.paused, "ERR_PAUSED");
        } else if caller == self.owner {
            assert_one_yocto();
        } else {
            env::panic_str("ERR_NOT_AGENT_OR_OWNER");
        }
        require_gas(MIN_RESCUE_GAS, "ERR_NOT_ENOUGH_GAS: attach 300 TGas to approve_pool");
        self.activated_address();
        let req = RescueRequest {
            amount: self.limits.daily_cap.0,
            max_fee_per_gas: max_fee_per_gas.0,
            max_priority_fee_per_gas: max_priority_fee_per_gas.0,
            gas_limit: gas_limit.0,
        };
        check_tx_params(&self.limits, &req).unwrap_or_else(|e| env::panic_str(e));
        let now = now_secs();
        if let Some(last) = self.last_approve_at {
            require!(now >= last.saturating_add(APPROVE_MIN_INTERVAL_SECS), "ERR_APPROVE_TOO_SOON");
        }
        let call = EvmCall {
            chain_id: self.chain_id,
            nonce: evm_nonce.0,
            to: self.usdc_base,
            value: 0,
            data: evm::encode_approve(&self.aave_pool, req.amount),
            max_fee_per_gas: req.max_fee_per_gas,
            max_priority_fee_per_gas: req.max_priority_fee_per_gas,
            gas_limit: req.gas_limit,
        };
        self.request_signature(TxKind::ApprovePool, req.amount, call, now, None)
    }

    /// Callback from `v1.signer.sign`. On success returns the signed Base tx. On failure it emits
    /// `rescue_failed` and returns a promise to `fail_rescue`, which panics so the caller's
    /// transaction fails (a panic here would revert the state change). The budget is rolled back
    /// only when the MPC call itself failed: any other failure (malformed or oversized response,
    /// wrong signer) means MPC returned something, which is public in the `sign` receipt and may
    /// be a usable signature, so the budget and cooldown stay spent (fail closed).
    #[private]
    pub fn on_signed(&mut self, rescue_id: u64) -> PromiseOrValue<RescueSigned> {
        let pending = self.pending.remove(&rescue_id).unwrap_or_else(|| env::panic_str("ERR_UNKNOWN_RESCUE"));
        match self.finish(rescue_id, &pending, env::promise_result_checked(0, MAX_SIGN_RESPONSE_LEN)) {
            Ok(signed) => {
                emit(
                    "rescue_signed",
                    json!({
                        "rescue_id": rescue_id,
                        "kind": pending.kind,
                        "amount": signed.amount,
                        "evm_nonce": pending.evm_nonce,
                        "tx_hash": signed.tx_hash,
                    }),
                );
                PromiseOrValue::Value(signed)
            }
            Err(reason) => {
                if reason == ERR_MPC_SIGN_FAILED {
                    self.roll_back(&pending);
                }
                emit(
                    "rescue_failed",
                    json!({
                        "rescue_id": rescue_id,
                        "kind": pending.kind,
                        "amount": U128(pending.amount),
                        "evm_nonce": pending.evm_nonce,
                        "reason": reason,
                    }),
                );
                PromiseOrValue::Promise(
                    Self::ext(env::current_account_id())
                        .with_static_gas(FAIL_GAS)
                        .with_unused_gas_weight(0)
                        .fail_rescue(rescue_id, reason.to_string()),
                )
            }
        }
    }

    /// Makes the signing transaction fail visibly after `on_signed` has committed its state change.
    #[private]
    pub fn fail_rescue(&self, rescue_id: u64, reason: String) {
        let budget = if reason == ERR_MPC_SIGN_FAILED { "budget restored" } else { "budget kept" };
        env::panic_str(&format!("ERR_RESCUE_FAILED: rescue {rescue_id} not signed ({reason}); {budget}"))
    }

    // ---------------------------------------------------------------- views

    pub fn get_limits(&self) -> LimitsView {
        LimitsView { limits: self.limits.clone(), paused: self.paused }
    }

    pub fn get_status(&self) -> StatusView {
        let now = now_secs();
        let b = self.budget.at(now);
        let bb = self.bridge_budget.at(now);
        let cooldown = self.limits.cooldown_secs;
        StatusView {
            spent_today: U128(b.spent_today),
            day_start: U64(b.day_start),
            last_rescue_at: U64(b.last_rescue_at.unwrap_or(0)),
            rescue_count: self.rescue_count,
            remaining_today: U128(self.limits.daily_cap.0.saturating_sub(b.spent_today)),
            cooldown_ends_at: U64(b.cooldown_ends_at(cooldown).unwrap_or(0)),
            bridge_spent_today: U128(bb.spent_today),
            bridge_remaining_today: U128(self.limits.daily_cap.0.saturating_sub(bb.spent_today)),
            last_bridge_at: U64(bb.last_rescue_at.unwrap_or(0)),
            bridge_cooldown_ends_at: U64(bb.cooldown_ends_at(cooldown).unwrap_or(0)),
            bridge_count: self.bridge_count,
            last_approve_at: U64(self.last_approve_at.unwrap_or(0)),
            last_bridge: self.last_bridge.as_ref().map(|l| LastBridgeView {
                bridge_id: l.bridge_id,
                amount_in: U128(l.amount_in),
                min_amount_out: U128(l.min_amount_out),
                deposit_address: l.deposit_address.to_string(),
                funded_at: U64(l.funded_at),
            }),
        }
    }

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            version: CONTRACT_VERSION.to_string(),
            owner: self.owner.clone(),
            agent: self.agent.clone(),
            base_address: self.base_address.as_ref().map(evm::format_evm_address),
            on_behalf_of: evm::format_evm_address(&self.on_behalf_of),
            chain_id: self.chain_id,
            aave_pool: evm::format_evm_address(&self.aave_pool),
            usdc_base: evm::format_evm_address(&self.usdc_base),
            usdc_near: self.usdc_near.clone(),
            bridge_dest_asset: self.bridge_dest_asset.clone(),
            bridge_signer_pk: encode_ed25519(&self.bridge_signer_pk),
            mpc_contract: self.mpc_contract.clone(),
            derivation_path: self.derivation_path.clone(),
            fee_account: self.fee_account.clone(),
            fee_bps: self.fee_bps,
        }
    }
}

impl Policy {
    fn assert_closable(&self) {
        require!(self.paused, "ERR_NOT_PAUSED: pause the policy before closing it");
        require!(
            now_secs() >= self.last_request_at.saturating_add(CLOSE_QUIET_SECS),
            "ERR_CLOSE_TOO_SOON: wait one hour after the last rescue, approve or bridge request"
        );
    }

    fn activated_address(&self) -> Address {
        self.base_address.unwrap_or_else(|| env::panic_str("ERR_NOT_ACTIVATED: call activate first"))
    }

    /// Shared tail of every signing method: snapshot the tx, ask MPC to sign its hash, and
    /// resume in `on_signed`. For `ApprovePool` this also records `last_approve_at`.
    fn request_signature(
        &mut self,
        kind: TxKind,
        amount: u128,
        call: EvmCall,
        now: u64,
        prior_last_rescue_at: Option<u64>,
    ) -> Promise {
        let payload_hash = evm::signing_hash(&call.build());
        let rescue_id = self.next_rescue_id;
        self.next_rescue_id += 1;
        let prior_last_approve_at = self.last_approve_at;
        self.last_request_at = now;
        if kind == TxKind::ApprovePool {
            self.last_approve_at = Some(now);
        }
        self.pending.insert(
            rescue_id,
            PendingSign {
                kind,
                amount,
                to: call.to,
                value: call.value,
                data: call.data,
                evm_nonce: call.nonce,
                max_fee_per_gas: call.max_fee_per_gas,
                max_priority_fee_per_gas: call.max_priority_fee_per_gas,
                gas_limit: call.gas_limit,
                payload_hash,
                day_start: self.budget.day_start,
                requested_at: now,
                prior_last_rescue_at,
                prior_last_approve_at,
            },
        );

        let payload_hex = hex::encode(payload_hash);
        emit(
            "rescue_requested",
            json!({
                "rescue_id": rescue_id,
                "kind": kind,
                "amount": U128(amount),
                "evm_nonce": call.nonce,
                "payload": payload_hex,
            }),
        );

        let args = json!({
            "request": {
                "payload_v2": { "Ecdsa": payload_hex },
                "path": self.derivation_path,
                "domain_id": SECP256K1_DOMAIN_ID,
            }
        });
        Promise::new(self.mpc_contract.clone())
            .function_call_weight("sign", args.to_string().into_bytes(), SIGN_DEPOSIT, SIGN_STATIC_GAS, GasWeight(1))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .with_unused_gas_weight(0)
                    .on_signed(rescue_id),
            )
    }

    fn pending_call(&self, p: &PendingSign) -> EvmCall {
        EvmCall {
            chain_id: self.chain_id,
            nonce: p.evm_nonce,
            to: p.to,
            value: p.value,
            data: p.data.clone(),
            max_fee_per_gas: p.max_fee_per_gas,
            max_priority_fee_per_gas: p.max_priority_fee_per_gas,
            gas_limit: p.gas_limit,
        }
    }

    fn finish(
        &self,
        rescue_id: u64,
        p: &PendingSign,
        result: Result<Vec<u8>, PromiseError>,
    ) -> Result<RescueSigned, &'static str> {
        let bytes = result.map_err(|e| match e {
            PromiseError::Failed => ERR_MPC_SIGN_FAILED,
            _ => "ERR_MPC_RESPONSE_TOO_LONG",
        })?;
        let sig: RawSignature = evm::parse_sign_response(&bytes)?;
        let base = self.base_address.ok_or("ERR_NOT_ACTIVATED")?;
        if !evm::signer_matches(&p.payload_hash, &sig, &base) {
            return Err("ERR_SIGNER_NOT_BASE_ADDRESS");
        }
        let signed = evm::assemble_signed_tx(&self.pending_call(p).build(), &sig);
        Ok(RescueSigned {
            rescue_id,
            kind: p.kind,
            amount: U128(p.amount),
            tx_hash: format!("0x{}", hex::encode(env::keccak256_array(&signed))),
            signed_tx: format!("0x{}", hex::encode(&signed)),
        })
    }

    /// Undo exactly what the signing method reserved, unless something newer superseded it.
    fn roll_back(&mut self, p: &PendingSign) {
        match p.kind {
            TxKind::Repay => {
                if self.budget.day_start == p.day_start {
                    self.budget.spent_today = self.budget.spent_today.saturating_sub(p.amount);
                }
                if self.budget.last_rescue_at == Some(p.requested_at) {
                    self.budget.last_rescue_at = p.prior_last_rescue_at;
                }
                self.rescue_count = self.rescue_count.saturating_sub(1);
            }
            TxKind::ApprovePool => {
                if self.last_approve_at == Some(p.requested_at) {
                    self.last_approve_at = p.prior_last_approve_at;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests;
