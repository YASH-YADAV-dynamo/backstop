/** Chain Signatures address derivation for an EVM loan chain (the address is the same on every EVM chain). */
import { baseDecode, type Provider } from "near-api-js";
import { getAddress, toHex, type Address, type Hex } from "viem";
import { publicKeyToAddress } from "viem/accounts";
import { NEAR, type LoanChain } from "@backstop/config";
import { evmClient, viewCall } from "@backstop/chains";
import { evmAdapter } from "./contract.js";

export interface DerivedAddress {
  address: Address;
  /** uncompressed SEC1 public key, 0x04... */
  publicKey: Hex;
}

/**
 * The EVM address controlled by `predecessor` (the NEAR account that calls v1.signer)
 * at `path`. Computed locally by chainsig.js from the mainnet MPC root key; no network call.
 */
export async function deriveEvmAddress(chain: LoanChain, predecessor: string, path: string): Promise<DerivedAddress> {
  const { address, publicKey } = await evmAdapter(evmClient(chain)).deriveAddressAndPublicKey(
    predecessor,
    path,
  );
  return { address: getAddress(address), publicKey: `0x${publicKey.replace(/^0x/, "")}` };
}

/** `secp256k1:<base58 of 64-byte x||y>` (NEAR format) -> 0x04-prefixed uncompressed key. */
export function najPublicKeyToSec1(najKey: string): Hex {
  const [curve, data] = najKey.split(":");
  if (curve !== "secp256k1" || !data) {
    throw new Error(`Expected a "secp256k1:..." public key from ${NEAR.mpcContract}, got "${najKey}".`);
  }
  const raw = baseDecode(data);
  if (raw.length !== 64) throw new Error(`Public key from ${NEAR.mpcContract} has ${raw.length} bytes, expected 64.`);
  return `0x04${toHex(raw).slice(2)}`;
}

/**
 * Asks v1.signer itself (`derived_public_key`, domain 0 = secp256k1) for the derived key
 * and turns it into a Base address with viem, independently of chainsig.js.
 */
export async function deriveAddressOnChain(
  provider: Provider,
  predecessor: string,
  path: string,
): Promise<DerivedAddress> {
  const najKey = await viewCall<string>(provider, NEAR.mpcContract, "derived_public_key", {
    path,
    predecessor,
    domain_id: 0,
  });
  const publicKey = najPublicKeyToSec1(najKey);
  return { address: publicKeyToAddress(publicKey), publicKey };
}
