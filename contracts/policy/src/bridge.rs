//! 1Click signed quotes: signature verification and the routing checks `fund_bridge` runs before
//! the policy pays a deposit address. Pure apart from the
//! sha256 / ed25519 host functions.
//!
//! The signed string is `json-stable-stringify({ ...signedRequestFields, ...signedQuoteFields, timestamp })`
//! and the signed message is the UTF-8 bytes of `base58(sha256(quote))`
//! (@defuse-protocol/one-click-sdk-typescript 0.1.26, `hashQuote` / `verifyQuoteSignature`).

use near_sdk::serde::Deserialize;
use near_sdk::serde_json::{self, Value};
use near_sdk::{env, AccountId};
use omni_transaction::evm::types::Address;

use crate::evm::format_evm_address;
use crate::time::parse_iso_utc;

pub const MAX_QUOTE_LEN: usize = 4096;
/// The quote `timestamp` must be at most this old.
pub const MAX_QUOTE_AGE_SECS: u64 = 600;
/// Tolerated clock skew for a quote `timestamp` ahead of the block time.
pub const MAX_QUOTE_FUTURE_SECS: u64 = 120;
/// The deposit address must stay active at least this long after the bridge.
pub const MIN_QUOTE_DEADLINE_MARGIN_SECS: u64 = 600;
/// `minAmountOut >= 98%` of `amountIn`.
pub const MAX_BRIDGE_LOSS_BPS: u128 = 200;
/// 0.1 USDC: stops dust bridges from draining the policy's NEAR on deposit-address storage.
pub const MIN_BRIDGE_AMOUNT: u128 = 100_000;

const ED25519_PREFIX: &str = "ed25519:";

/// The signed quote. Unknown fields are rejected (fail closed if 1Click adds routing options):
/// `customRecipientMsg`, `virtualChainRecipient`, `virtualChainRefundRecipient`, `depositMemo`
/// are deliberately absent so their presence fails parsing.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", rename_all = "camelCase", deny_unknown_fields)]
#[allow(dead_code)] // the informational fields are parsed only so that their presence is allowed
struct SignedQuote {
    dry: bool,
    swap_type: String,
    deposit_type: String,
    origin_asset: String,
    destination_asset: String,
    recipient: String,
    recipient_type: String,
    refund_to: String,
    refund_type: String,
    deposit_address: String,
    amount: String,
    amount_in: String,
    min_amount_in: String,
    amount_out: String,
    min_amount_out: String,
    deadline: String,
    timestamp: String,
    slippage_tolerance: Value,
    amount_in_formatted: Option<Value>,
    amount_in_usd: Option<Value>,
    amount_out_formatted: Option<Value>,
    amount_out_usd: Option<Value>,
    time_when_inactive: Option<Value>,
    time_estimate: Option<Value>,
    refund_fee: Option<Value>,
    withdraw_fee: Option<Value>,
    quote_waiting_time_ms: Option<Value>,
    referral: Option<Value>,
}

/// What the policy requires of every quote it pays.
pub struct QuoteExpectations<'a> {
    pub usdc_near: &'a AccountId,
    pub dest_asset: &'a str,
    /// The policy's derived Base address.
    pub recipient: &'a Address,
    /// The policy account itself.
    pub refund_to: &'a AccountId,
    pub now: u64,
}

/// The fields `fund_bridge` acts on, after every check passed.
#[derive(Debug, PartialEq, Eq)]
pub struct CheckedQuote {
    pub amount_in: u128,
    pub min_amount_out: u128,
    pub deposit_address: AccountId,
}

/// Decodes `ed25519:<base58>` into exactly `N` bytes.
pub fn decode_ed25519<const N: usize>(s: &str) -> Option<[u8; N]> {
    let raw = near_sdk::bs58::decode(s.strip_prefix(ED25519_PREFIX)?).into_vec().ok()?;
    raw.try_into().ok()
}

pub fn encode_ed25519(bytes: &[u8]) -> String {
    format!("{ED25519_PREFIX}{}", near_sdk::bs58::encode(bytes).into_string())
}

/// Rows 4-6: length, signature format, ed25519 signature by `signer_pk`. Returns sha256(quote).
pub fn verify_quote_signature(quote: &str, signature: &str, signer_pk: &[u8; 32]) -> Result<[u8; 32], &'static str> {
    if quote.len() > MAX_QUOTE_LEN {
        return Err("ERR_QUOTE_TOO_LONG");
    }
    let sig: [u8; 64] = decode_ed25519(signature).ok_or("ERR_QUOTE_SIGNATURE_FORMAT")?;
    let hash = env::sha256_array(quote.as_bytes());
    let message = near_sdk::bs58::encode(hash).into_string();
    if !env::ed25519_verify(&sig, message.as_bytes(), signer_pk) {
        return Err("ERR_QUOTE_SIGNATURE_INVALID");
    }
    Ok(hash)
}

fn parse_amount(s: &str) -> Result<u128, &'static str> {
    if s.is_empty() || !s.bytes().all(|c| c.is_ascii_digit()) {
        return Err("ERR_QUOTE_AMOUNT_FORMAT");
    }
    s.parse().map_err(|_| "ERR_QUOTE_AMOUNT_FORMAT")
}

fn is_implicit_account(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
}

/// Rows 7-23. Pure.
pub fn check_quote(quote: &str, want: &QuoteExpectations) -> Result<CheckedQuote, &'static str> {
    let q: SignedQuote = serde_json::from_str(quote).map_err(|_| "ERR_QUOTE_SHAPE")?;
    if q.dry {
        return Err("ERR_QUOTE_DRY");
    }
    if q.swap_type != "EXACT_INPUT" {
        return Err("ERR_QUOTE_SWAP_TYPE");
    }
    if q.deposit_type != "ORIGIN_CHAIN" {
        return Err("ERR_QUOTE_DEPOSIT_TYPE");
    }
    if q.origin_asset != format!("nep141:{}", want.usdc_near) {
        return Err("ERR_QUOTE_ORIGIN_ASSET");
    }
    if q.destination_asset != want.dest_asset {
        return Err("ERR_QUOTE_DESTINATION_ASSET");
    }
    if q.recipient_type != "DESTINATION_CHAIN" {
        return Err("ERR_QUOTE_RECIPIENT_TYPE");
    }
    if q.recipient.to_ascii_lowercase() != format_evm_address(want.recipient) {
        return Err("ERR_QUOTE_RECIPIENT");
    }
    if q.refund_type != "ORIGIN_CHAIN" {
        return Err("ERR_QUOTE_REFUND_TYPE");
    }
    if q.refund_to != want.refund_to.as_str() {
        return Err("ERR_QUOTE_REFUND_TO");
    }
    if !is_implicit_account(&q.deposit_address) {
        return Err("ERR_QUOTE_DEPOSIT_ADDRESS");
    }
    let deposit_address: AccountId = q.deposit_address.parse().map_err(|_| "ERR_QUOTE_DEPOSIT_ADDRESS")?;
    let amount = parse_amount(&q.amount)?;
    let amount_in = parse_amount(&q.amount_in)?;
    let min_amount_in = parse_amount(&q.min_amount_in)?;
    parse_amount(&q.amount_out)?;
    let min_amount_out = parse_amount(&q.min_amount_out)?;
    if amount != amount_in || min_amount_in != amount_in {
        return Err("ERR_QUOTE_AMOUNT_MISMATCH");
    }
    if amount_in < MIN_BRIDGE_AMOUNT {
        return Err("ERR_BRIDGE_AMOUNT_TOO_SMALL");
    }
    let out_scaled = min_amount_out.checked_mul(10_000).ok_or("ERR_QUOTE_AMOUNT_FORMAT")?;
    let in_scaled = amount_in.checked_mul(10_000 - MAX_BRIDGE_LOSS_BPS).ok_or("ERR_QUOTE_AMOUNT_FORMAT")?;
    if out_scaled < in_scaled {
        return Err("ERR_QUOTE_LOSS_TOO_HIGH");
    }
    let ts = parse_iso_utc(&q.timestamp)?;
    if ts < want.now.saturating_sub(MAX_QUOTE_AGE_SECS) || ts > want.now + MAX_QUOTE_FUTURE_SECS {
        return Err("ERR_QUOTE_STALE");
    }
    let deadline = parse_iso_utc(&q.deadline)?;
    if deadline < want.now + MIN_QUOTE_DEADLINE_MARGIN_SECS {
        return Err("ERR_QUOTE_DEADLINE_TOO_SOON");
    }
    Ok(CheckedQuote { amount_in, min_amount_out, deposit_address })
}
