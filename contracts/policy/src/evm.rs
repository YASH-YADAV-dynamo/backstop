//! Pure EVM helpers: address parsing, Aave `repay` / ERC-20 calldata, EIP-1559 transactions,
//! MPC signature parsing and signed-transaction assembly. No contract state is touched here.

use near_sdk::env;
use near_sdk::serde::Deserialize;
use near_sdk::serde_json::{self, Value};
use omni_transaction::evm::types::{Address, Signature};
use omni_transaction::evm::EVMTransaction;
use omni_transaction::{TransactionBuilder, TxBuilder, EVM};

/// First 4 bytes of keccak256("repay(address,uint256,uint256,address)").
pub const REPAY_SELECTOR: [u8; 4] = [0x57, 0x3a, 0xde, 0x81];
/// First 4 bytes of keccak256("approve(address,uint256)").
pub const APPROVE_SELECTOR: [u8; 4] = [0x09, 0x5e, 0xa7, 0xb3];
/// First 4 bytes of keccak256("transfer(address,uint256)").
pub const TRANSFER_SELECTOR: [u8; 4] = [0xa9, 0x05, 0x9c, 0xbb];
/// Aave v3 `interestRateMode` for variable-rate debt.
pub const VARIABLE_RATE_MODE: u128 = 2;

/// secp256k1 group order n, big-endian.
const SECP256K1_N: [u8; 32] = [
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe,
    0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36, 0x41, 0x41,
];
/// floor(n / 2), big-endian. Ethereum (EIP-2) rejects signatures with s above this.
const SECP256K1_HALF_N: [u8; 32] = [
    0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0x5d, 0x57, 0x6e, 0x73, 0x57, 0xa4, 0x50, 0x1d, 0xdf, 0xe9, 0x2f, 0x46, 0x68, 0x1b, 0x20, 0xa0,
];

/// Parses a `0x`-prefixed, 40-hex-char EVM address. Rejects the zero address.
pub fn parse_evm_address(s: &str) -> Result<Address, &'static str> {
    let hex_part = s.strip_prefix("0x").ok_or("ERR_EVM_ADDRESS_MISSING_0X")?;
    if hex_part.len() != 40 {
        return Err("ERR_EVM_ADDRESS_LENGTH");
    }
    let bytes = hex::decode(hex_part).map_err(|_| "ERR_EVM_ADDRESS_NOT_HEX")?;
    let mut out = [0u8; 20];
    out.copy_from_slice(&bytes);
    if out == [0u8; 20] {
        return Err("ERR_EVM_ADDRESS_ZERO");
    }
    Ok(out)
}

pub fn format_evm_address(a: &Address) -> String {
    format!("0x{}", hex::encode(a))
}

fn word_address(a: &Address) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(a);
    w
}

fn word_u128(v: u128) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[16..].copy_from_slice(&v.to_be_bytes());
    w
}

/// ABI-encodes `repay(asset, amount, 2, on_behalf_of)` for the Aave v3 Pool.
pub fn encode_repay(asset: &Address, amount: u128, on_behalf_of: &Address) -> Vec<u8> {
    let mut data = Vec::with_capacity(4 + 32 * 4);
    data.extend_from_slice(&REPAY_SELECTOR);
    data.extend_from_slice(&word_address(asset));
    data.extend_from_slice(&word_u128(amount));
    data.extend_from_slice(&word_u128(VARIABLE_RATE_MODE));
    data.extend_from_slice(&word_address(on_behalf_of));
    data
}

/// ABI-encodes ERC-20 `approve(spender, amount)`.
pub fn encode_approve(spender: &Address, amount: u128) -> Vec<u8> {
    let mut data = Vec::with_capacity(4 + 32 * 2);
    data.extend_from_slice(&APPROVE_SELECTOR);
    data.extend_from_slice(&word_address(spender));
    data.extend_from_slice(&word_u128(amount));
    data
}

/// ABI-encodes ERC-20 `transfer(to, amount)`.
pub fn encode_transfer(to: &Address, amount: u128) -> Vec<u8> {
    let mut data = Vec::with_capacity(4 + 32 * 2);
    data.extend_from_slice(&TRANSFER_SELECTOR);
    data.extend_from_slice(&word_address(to));
    data.extend_from_slice(&word_u128(amount));
    data
}

/// One EIP-1559 call on Base. The contract fills `to`, `value` and `data` itself for each kind
/// of transaction it is willing to sign; callers only choose nonce and fees (within the caps).
pub struct EvmCall {
    pub chain_id: u64,
    pub nonce: u64,
    pub to: Address,
    pub value: u128,
    pub data: Vec<u8>,
    pub max_fee_per_gas: u128,
    pub max_priority_fee_per_gas: u128,
    pub gas_limit: u128,
}

impl EvmCall {
    pub fn build(&self) -> EVMTransaction {
        TransactionBuilder::new::<EVM>()
            .chain_id(self.chain_id)
            .nonce(self.nonce)
            .to(self.to)
            .value(self.value)
            .input(self.data.clone())
            .max_priority_fee_per_gas(self.max_priority_fee_per_gas)
            .max_fee_per_gas(self.max_fee_per_gas)
            .gas_limit(self.gas_limit)
            .build()
    }
}

/// keccak256 of the EIP-1559 signing preimage (0x02 || rlp([...])). This is what MPC signs.
pub fn signing_hash(tx: &EVMTransaction) -> [u8; 32] {
    env::keccak256_array(tx.build_for_signing())
}

/// A secp256k1 signature normalised for Ethereum: low-s, y_parity in {0, 1}.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawSignature {
    pub r: [u8; 32],
    pub s: [u8; 32],
    pub y_parity: u8,
}

impl RawSignature {
    /// r || s, as `env::ecrecover` expects.
    pub fn rs_bytes(&self) -> [u8; 64] {
        let mut out = [0u8; 64];
        out[..32].copy_from_slice(&self.r);
        out[32..].copy_from_slice(&self.s);
        out
    }
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct MpcAffinePoint {
    affine_point: String,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct MpcScalar {
    scalar: String,
}

/// Shape returned by `v1.signer` `sign` for secp256k1:
/// `{ "big_r": { "affine_point": "02.." }, "s": { "scalar": ".." }, "recovery_id": 0 }`
/// (extra fields such as `"scheme": "Secp256k1"` are ignored).
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct MpcSignature {
    big_r: MpcAffinePoint,
    s: MpcScalar,
    recovery_id: u8,
}

fn decode_hex_fixed<const N: usize>(s: &str, err: &'static str) -> Result<[u8; N], &'static str> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    let bytes = hex::decode(s).map_err(|_| err)?;
    if bytes.len() != N {
        return Err(err);
    }
    let mut out = [0u8; N];
    out.copy_from_slice(&bytes);
    Ok(out)
}

/// Finds the object carrying `big_r`: either the top level, or one level down when the
/// response is wrapped (e.g. `{"Secp256k1": {...}}` or `{"Ok": {...}}`).
fn find_signature_object(v: Value) -> Option<Value> {
    if v.get("big_r").is_some() {
        return Some(v);
    }
    match v {
        Value::Object(map) => map.into_iter().map(|(_, inner)| inner).find(|inner| inner.get("big_r").is_some()),
        _ => None,
    }
}

/// Parses the raw bytes returned by the MPC `sign` call into an Ethereum-ready signature.
pub fn parse_sign_response(bytes: &[u8]) -> Result<RawSignature, &'static str> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| "ERR_SIGN_RESPONSE_NOT_JSON")?;
    let obj = find_signature_object(value).ok_or("ERR_SIGN_RESPONSE_NO_BIG_R")?;
    let sig: MpcSignature = serde_json::from_value(obj).map_err(|_| "ERR_SIGN_RESPONSE_SHAPE")?;
    let big_r: [u8; 33] = decode_hex_fixed(&sig.big_r.affine_point, "ERR_SIGN_RESPONSE_BIG_R")?;
    if big_r[0] != 0x02 && big_r[0] != 0x03 {
        return Err("ERR_SIGN_RESPONSE_BIG_R_PREFIX");
    }
    let s: [u8; 32] = decode_hex_fixed(&sig.s.scalar, "ERR_SIGN_RESPONSE_S")?;
    if sig.recovery_id > 1 {
        return Err("ERR_SIGN_RESPONSE_RECOVERY_ID");
    }
    let mut r = [0u8; 32];
    r.copy_from_slice(&big_r[1..]);
    Ok(normalize_low_s(r, s, sig.recovery_id))
}

/// Ethereum requires s <= n/2. If s is high, use (n - s) and flip the parity (same signer).
pub fn normalize_low_s(r: [u8; 32], s: [u8; 32], y_parity: u8) -> RawSignature {
    if s <= SECP256K1_HALF_N {
        return RawSignature { r, s, y_parity };
    }
    let mut out = [0u8; 32];
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let mut d = SECP256K1_N[i] as i16 - s[i] as i16 - borrow;
        borrow = if d < 0 {
            d += 256;
            1
        } else {
            0
        };
        out[i] = d as u8;
    }
    RawSignature { r, s: out, y_parity: y_parity ^ 1 }
}

/// RLP integers must be minimal: strip leading zero bytes from r and s.
fn trim_leading_zeros(bytes: &[u8]) -> Vec<u8> {
    let first = bytes.iter().position(|b| *b != 0).unwrap_or(bytes.len());
    bytes[first..].to_vec()
}

/// Raw signed EIP-1559 transaction bytes, ready for `eth_sendRawTransaction`.
pub fn assemble_signed_tx(tx: &EVMTransaction, sig: &RawSignature) -> Vec<u8> {
    tx.build_with_signature(&Signature {
        v: u64::from(sig.y_parity),
        r: trim_leading_zeros(&sig.r),
        s: trim_leading_zeros(&sig.s),
    })
}

/// Ethereum address of an uncompressed secp256k1 public key (64 bytes, no 0x04 prefix).
pub fn address_from_public_key(pubkey: &[u8; 64]) -> Address {
    let h = env::keccak256_array(pubkey);
    let mut a = [0u8; 20];
    a.copy_from_slice(&h[12..]);
    a
}

/// Recovers the signer of `hash` and checks it is `expected`.
pub fn signer_matches(hash: &[u8; 32], sig: &RawSignature, expected: &Address) -> bool {
    env::ecrecover(hash, &sig.rs_bytes(), sig.y_parity, true)
        .map(|pk| address_from_public_key(&pk) == *expected)
        .unwrap_or(false)
}

/// Parses the `v1.signer.derived_public_key` result, a JSON string
/// `"secp256k1:<base58 of the 64-byte uncompressed point x || y>"`, into its Ethereum address.
pub fn parse_derived_key(bytes: &[u8]) -> Result<Address, &'static str> {
    let s: String = serde_json::from_slice(bytes).map_err(|_| "ERR_DERIVE_FAILED: response is not a JSON string")?;
    let b58 = s.strip_prefix("secp256k1:").ok_or("ERR_DERIVE_FAILED: key is not secp256k1")?;
    let raw = near_sdk::bs58::decode(b58).into_vec().map_err(|_| "ERR_DERIVE_FAILED: key is not base58")?;
    let point: [u8; 64] = raw.try_into().map_err(|_| "ERR_DERIVE_FAILED: key is not 64 bytes")?;
    let address = address_from_public_key(&point);
    if address == [0u8; 20] {
        return Err("ERR_DERIVE_FAILED: zero address");
    }
    Ok(address)
}
