//! Backstop vault factory (design D32, section K).
//!
//! Lets anyone create their own keyless Backstop policy ("Rescue vault") with one function call.
//! The policy code is embedded in this contract (`POLICY_WASM`), so the factory's own code hash pins
//! it. The chain allow-list and every chain constant are fixed in `new`; there are no setters. The
//! vault's name is assigned by the factory from a counter, its owner is always the caller, and its
//! account never gets an access key. The factory account itself is meant to have no access keys.

#[allow(dead_code)]
#[path = "../../policy/src/limits.rs"]
mod limits;

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
    PromiseOrValue,
};

pub use crate::limits::Limits;

/// The policy contract this factory deploys, byte for byte. Build it first (`pnpm contract:build`).
pub const POLICY_WASM: &[u8] = include_bytes!("../../policy/target/near/backstop_policy.wasm");

/// `create_policy` refuses less prepaid gas than this; the web attaches 300 TGas.
pub const MIN_CREATE_GAS: Gas = Gas::from_tgas(250);
/// Gas for the policy's `new` in the create batch.
pub const NEW_GAS: Gas = Gas::from_tgas(30);
/// Static gas of `on_policy_created` (it also gets the unused gas of `create_policy`).
pub const CREATE_CALLBACK_GAS: Gas = Gas::from_tgas(80);
/// Gas for the detached `policy.activate()` scheduled by the success callback.
pub const ACTIVATE_GAS: Gas = Gas::from_tgas(50);
/// Gas for the detached USDC `storage_deposit` scheduled by the success callback.
pub const FT_STORAGE_GAS: Gas = Gas::from_tgas(10);
pub const FAIL_GAS: Gas = Gas::from_tgas(5);

/// NEAR USDC storage_balance_bounds (min == max), paid by the factory for each new vault.
pub const FT_STORAGE_DEPOSIT: NearToken = NearToken::from_yoctonear(1_250_000_000_000_000_000_000);
/// Kept by the factory for the two index entries of a vault (~300 bytes of state).
pub const INDEX_FEE: NearToken = NearToken::from_millinear(5);
/// Policy state after `new` + `activate` (~1 KB).
pub const POLICY_STATE_MARGIN: NearToken = NearToken::from_millinear(50);
/// Spare balance of a new vault (MPC deposits, used-quote entries, 1Click token storage).
pub const POLICY_SPARE: NearToken = NearToken::from_millinear(100);
/// Balance the factory never spends on refunds, on top of its storage and recorded refunds.
pub const REFUND_RESERVE: NearToken = NearToken::from_millinear(50);

pub const MAX_VAULTS_PER_OWNER: usize = 8;
pub const MAX_FEE_BPS: u32 = 50;
pub const MAX_LIST_LIMIT: u64 = 100;
pub const DEFAULT_LIST_LIMIT: u64 = 50;
const MAX_ACCOUNT_ID_LEN: usize = 64;
/// Digits of `u64::MAX`: the longest index a vault name can carry.
const MAX_INDEX_DIGITS: usize = 20;
const MAX_CHAIN_KEY_LEN: usize = 12;

const EVENT_STANDARD: &str = "backstop";
const EVENT_VERSION: &str = "2.0.0";

/// One loan chain this factory creates vaults for. Fixed in `new`.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChainConfig {
    /// `^[a-z]{1,12}$`, e.g. "base"; the first label of the vault's account id.
    pub key: String,
    pub chain_id: u64,
    pub aave_pool: String,
    /// Native USDC on that chain (the policy's `usdc_base`).
    pub usdc: String,
    /// 1Click asset id of that USDC (the policy's `bridge_dest_asset`).
    pub bridge_dest_asset: String,
}

/// Everything a vault is created with besides the caller's own arguments. Fixed in `new`.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FactoryConfig {
    pub chains: Vec<ChainConfig>,
    pub usdc_near: AccountId,
    pub bridge_signer_pk: String,
    pub mpc_contract: AccountId,
    pub derivation_path: String,
    pub default_agent: AccountId,
    pub fee_account: AccountId,
    pub fee_bps: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PolicyEntry {
    pub policy: AccountId,
    pub owner: AccountId,
    pub chain: String,
}

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    ByOwner,
    All,
    Refunds,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Factory {
    config: FactoryConfig,
    /// sha256 of `POLICY_WASM`, computed once in `new`.
    code_hash: [u8; 32],
    /// Index of the next vault name; never decremented, never reused.
    next_index: u64,
    by_owner: LookupMap<AccountId, Vec<AccountId>>,
    all: Vector<PolicyEntry>,
    /// Refunds of failed creates the factory could not pay at once; claimable with `claim_refund`.
    refunds: LookupMap<AccountId, u128>,
    refunds_total: u128,
}

/// Same rules and codes as the policy's `evm::parse_evm_address`, so a bad address fails here,
/// before any account is created, with the error the policy would give.
pub fn check_evm_address(s: &str) -> Result<String, &'static str> {
    let hex_part = s.strip_prefix("0x").ok_or("ERR_EVM_ADDRESS_MISSING_0X")?;
    if hex_part.len() != 40 {
        return Err("ERR_EVM_ADDRESS_LENGTH");
    }
    let bytes = hex::decode(hex_part).map_err(|_| "ERR_EVM_ADDRESS_NOT_HEX")?;
    if bytes.iter().all(|b| *b == 0) {
        return Err("ERR_EVM_ADDRESS_ZERO");
    }
    Ok(format!("0x{}", hex::encode(bytes)))
}

fn is_chain_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= MAX_CHAIN_KEY_LEN && key.bytes().all(|b| b.is_ascii_lowercase())
}

/// Checks a config for the factory account `factory`; the error is the panic message.
pub fn validate_config(config: &FactoryConfig, factory: &AccountId) -> Result<(), String> {
    if config.chains.is_empty() {
        return Err("ERR_NO_CHAINS: configure at least one loan chain".into());
    }
    for (i, c) in config.chains.iter().enumerate() {
        if !is_chain_key(&c.key) {
            return Err(format!("ERR_CHAIN_KEY_FORMAT: chains[{i}].key must be 1-12 lowercase letters"));
        }
        if c.chain_id == 0 {
            return Err(format!("ERR_CHAIN_ID_ZERO: chains[{i}].chain_id"));
        }
        if config.chains[..i].iter().any(|p| p.key == c.key || p.chain_id == c.chain_id) {
            return Err(format!("ERR_DUPLICATE_CHAIN: chains[{i}] repeats the key or chain_id of an earlier chain"));
        }
        check_evm_address(&c.aave_pool).map_err(|e| format!("{e}: chains[{i}].aave_pool"))?;
        check_evm_address(&c.usdc).map_err(|e| format!("{e}: chains[{i}].usdc"))?;
        if c.bridge_dest_asset.is_empty() {
            return Err(format!("ERR_CONFIG_FIELD_EMPTY: chains[{i}].bridge_dest_asset"));
        }
        // `<key>-<u64>.<factory>` must be a valid account id for every index the counter can reach.
        if c.key.len() + 1 + MAX_INDEX_DIGITS + 1 + factory.as_str().len() > MAX_ACCOUNT_ID_LEN {
            return Err(format!(
                "ERR_FACTORY_ID_TOO_LONG: {factory} is too long for {}-<index>.{factory} (max 64 chars); use a shorter factory account",
                c.key
            ));
        }
    }
    if config.derivation_path.is_empty() {
        return Err("ERR_CONFIG_FIELD_EMPTY: derivation_path".into());
    }
    if config.bridge_signer_pk.is_empty() {
        return Err("ERR_CONFIG_FIELD_EMPTY: bridge_signer_pk".into());
    }
    let pk_ok = config
        .bridge_signer_pk
        .strip_prefix("ed25519:")
        .and_then(|b58| near_sdk::bs58::decode(b58).into_vec().ok())
        .is_some_and(|bytes| bytes.len() == 32);
    if !pk_ok {
        return Err("ERR_BRIDGE_SIGNER_FORMAT: expected ed25519:<base58 of 32 bytes>".into());
    }
    if config.fee_bps > MAX_FEE_BPS {
        return Err("ERR_FEE_ABOVE_CAP_BPS: the service fee is at most 50 bps (0.50%)".into());
    }
    if &config.fee_account == factory {
        return Err("ERR_FEE_ACCOUNT_IS_FACTORY: pay the fee to an account you control".into());
    }
    Ok(())
}

/// NEP-297 event log with a fixed key order: standard, version, event, data.
fn emit(event: &str, data: Value) {
    env::log_str(&format!(
        r#"EVENT_JSON:{{"standard":"{EVENT_STANDARD}","version":"{EVENT_VERSION}","event":"{event}","data":[{data}]}}"#
    ));
}

fn policy_name(key: &str, index: u64, factory: &AccountId) -> AccountId {
    format!("{key}-{index}.{factory}")
        .parse()
        .unwrap_or_else(|_| env::panic_str("ERR_FACTORY_ID_TOO_LONG: the vault name is not a valid account id"))
}

#[near]
impl Factory {
    /// Called once, in the transaction that deploys the factory. near-sdk refuses a second call.
    #[init]
    pub fn new(config: FactoryConfig) -> Self {
        if let Err(e) = validate_config(&config, &env::current_account_id()) {
            env::panic_str(&e);
        }
        Self {
            config,
            code_hash: env::sha256_array(POLICY_WASM),
            next_index: env::block_height(),
            by_owner: LookupMap::new(StorageKey::ByOwner),
            all: Vector::new(StorageKey::All),
            refunds: LookupMap::new(StorageKey::Refunds),
            refunds_total: 0,
        }
    }

    // ---------------------------------------------------------------- create

    /// Creates `<chain>-<n>.<factory>`: a keyless policy owned by the caller, for the loan of
    /// `on_behalf_of` on `chain`, with the caller's `limits`. Attach `min_deposit()` and 300 TGas.
    #[payable]
    pub fn create_policy(&mut self, chain: String, on_behalf_of: String, limits: Limits) -> Promise {
        require!(env::prepaid_gas() >= MIN_CREATE_GAS, "ERR_NOT_ENOUGH_GAS: attach 300 TGas to create_policy");
        let cfg = self.config.chains.iter().find(|c| c.key == chain).cloned().unwrap_or_else(|| {
            let keys: Vec<&str> = self.config.chains.iter().map(|c| c.key.as_str()).collect();
            env::panic_str(&format!("ERR_UNKNOWN_CHAIN: this factory creates vaults for {}", keys.join(", ")))
        });
        let on_behalf_of =
            check_evm_address(&on_behalf_of).unwrap_or_else(|e| env::panic_str(&format!("{e}: on_behalf_of")));
        if let Err(e) = limits.validate() {
            env::panic_str(e);
        }
        let owner = env::predecessor_account_id();
        let owned = self.by_owner.get(&owner).map_or(0, Vec::len);
        require!(
            owned < MAX_VAULTS_PER_OWNER,
            "ERR_TOO_MANY_VAULTS: an account can create at most 8 vaults; close one or use another account"
        );
        let attached = env::attached_deposit();
        let min = self.min_deposit();
        require!(
            attached.as_yoctonear() >= min.0,
            format!("ERR_DEPOSIT_TOO_LOW: attach at least {} yoctoNEAR", min.0)
        );

        let factory = env::current_account_id();
        let policy_id = policy_name(&cfg.key, self.next_index, &factory);
        self.next_index += 1;

        let args = json!({
            "owner": owner,
            "agent": self.config.default_agent,
            "on_behalf_of": on_behalf_of,
            "chain_id": cfg.chain_id,
            "aave_pool": cfg.aave_pool,
            "usdc_base": cfg.usdc,
            "usdc_near": self.config.usdc_near,
            "bridge_dest_asset": cfg.bridge_dest_asset,
            "bridge_signer_pk": self.config.bridge_signer_pk,
            "mpc_contract": self.config.mpc_contract,
            "derivation_path": self.config.derivation_path,
            "limits": limits,
            "fee_account": self.config.fee_account,
            "fee_bps": self.config.fee_bps,
        });
        let transfer = attached.saturating_sub(FT_STORAGE_DEPOSIT).saturating_sub(INDEX_FEE);
        Promise::new(policy_id.clone())
            .create_account()
            .transfer(transfer)
            .deploy_contract(POLICY_WASM)
            .function_call("new", args.to_string().into_bytes(), NearToken::from_yoctonear(0), NEW_GAS)
            .then(Self::ext(factory).with_static_gas(CREATE_CALLBACK_GAS).on_policy_created(
                owner,
                policy_id,
                cfg.key,
                on_behalf_of,
                U128(attached.as_yoctonear()),
            ))
    }

    /// Callback of `create_policy`. Success: index the vault, then (detached) activate it and
    /// register it on NEAR USDC. Failure: refund the whole deposit (or record it) and fail visibly.
    #[private]
    pub fn on_policy_created(
        &mut self,
        owner: AccountId,
        policy_id: AccountId,
        chain: String,
        on_behalf_of: String,
        attached: U128,
    ) -> PromiseOrValue<AccountId> {
        if matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed)) {
            let available = env::account_balance()
                .as_yoctonear()
                .saturating_sub(u128::from(env::storage_usage()) * env::storage_byte_cost().as_yoctonear())
                .saturating_sub(self.refunds_total)
                .saturating_sub(REFUND_RESERVE.as_yoctonear());
            let paid = available >= attached.0;
            if paid {
                Promise::new(owner).transfer(NearToken::from_yoctonear(attached.0)).detach();
            } else {
                let owed = self.refunds.get(&owner).copied().unwrap_or(0).saturating_add(attached.0);
                self.refunds.insert(owner.clone(), owed);
                self.refunds_total = self.refunds_total.saturating_add(attached.0);
                emit("refund_pending", json!({ "owner": owner, "amount": attached }));
            }
            return PromiseOrValue::Promise(
                Self::ext(env::current_account_id())
                    .with_static_gas(FAIL_GAS)
                    .with_unused_gas_weight(0)
                    .fail_create(policy_id, !paid),
            );
        }
        let mut owned = self.by_owner.get(&owner).cloned().unwrap_or_default();
        owned.push(policy_id.clone());
        self.by_owner.insert(owner.clone(), owned);
        self.all.push(PolicyEntry { policy: policy_id.clone(), owner: owner.clone(), chain: chain.clone() });
        emit(
            "policy_created",
            json!({ "owner": owner, "policy": policy_id, "chain": chain, "on_behalf_of": on_behalf_of }),
        );
        Promise::new(policy_id.clone())
            .function_call("activate", b"{}".to_vec(), NearToken::from_yoctonear(0), ACTIVATE_GAS)
            .detach();
        Promise::new(self.config.usdc_near.clone())
            .function_call(
                "storage_deposit",
                json!({ "account_id": policy_id, "registration_only": true }).to_string().into_bytes(),
                FT_STORAGE_DEPOSIT,
                FT_STORAGE_GAS,
            )
            .detach();
        PromiseOrValue::Value(policy_id)
    }

    /// Makes the `create_policy` transaction fail visibly after the refund has been committed.
    #[private]
    pub fn fail_create(&self, policy_id: AccountId, refund_pending: bool) {
        let refund = if refund_pending { "call claim_refund" } else { "your deposit was refunded" };
        env::panic_str(&format!("ERR_CREATE_FAILED: {policy_id} was not created; {refund}"))
    }

    /// Pays the caller the refunds recorded for them by failed creates.
    pub fn claim_refund(&mut self) -> U128 {
        let owner = env::predecessor_account_id();
        let amount = self
            .refunds
            .remove(&owner)
            .unwrap_or_else(|| env::panic_str("ERR_NO_REFUND: this account has no refund to claim"));
        self.refunds_total = self.refunds_total.saturating_sub(amount);
        emit("refund_claimed", json!({ "owner": owner, "amount": U128(amount) }));
        Promise::new(owner).transfer(NearToken::from_yoctonear(amount)).detach();
        U128(amount)
    }

    // ---------------------------------------------------------------- views

    pub fn get_config(&self) -> FactoryConfig {
        self.config.clone()
    }

    pub fn get_policies(&self, owner: AccountId) -> Vec<AccountId> {
        self.by_owner.get(&owner).cloned().unwrap_or_default()
    }

    /// Every vault ever created, oldest first. `limit` defaults to 50 and is capped at 100.
    pub fn list_policies(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<PolicyEntry> {
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(DEFAULT_LIST_LIMIT).min(MAX_LIST_LIMIT);
        let len = u64::from(self.all.len());
        (from..len.min(from.saturating_add(limit)))
            .filter_map(|i| u32::try_from(i).ok().and_then(|i| self.all.get(i)).cloned())
            .collect()
    }

    pub fn policy_count(&self) -> U64 {
        U64(u64::from(self.all.len()))
    }

    /// Smallest deposit `create_policy` accepts: code storage of the policy, its state margin and
    /// spare, the USDC registration and the index entries.
    pub fn min_deposit(&self) -> U128 {
        let code = env::storage_byte_cost().as_yoctonear() * POLICY_WASM.len() as u128;
        U128(
            code + POLICY_STATE_MARGIN.as_yoctonear()
                + POLICY_SPARE.as_yoctonear()
                + FT_STORAGE_DEPOSIT.as_yoctonear()
                + INDEX_FEE.as_yoctonear(),
        )
    }

    /// sha256 of the embedded policy wasm, 64 lowercase hex (NEAR shows it base58 as `code_hash`).
    pub fn policy_code_hash(&self) -> String {
        hex::encode(self.code_hash)
    }

    /// The id the next vault on `chain` would get. Display only: another create may take it first.
    pub fn next_policy_id(&self, chain: String) -> AccountId {
        require!(self.config.chains.iter().any(|c| c.key == chain), "ERR_UNKNOWN_CHAIN");
        policy_name(&chain, self.next_index, &env::current_account_id())
    }

    pub fn get_refund(&self, owner: AccountId) -> U128 {
        U128(self.refunds.get(&owner).copied().unwrap_or(0))
    }
}

#[cfg(test)]
mod tests;
