/** Parses the secp256k1 signature v1.signer returns via yield/resume. */
import type { Hex } from "viem";

export interface MpcSignatureRaw {
  /** compressed SEC1 R point: 02|03 + 32-byte x, hex without 0x */
  big_r: { affine_point: string };
  /** 32-byte s, hex without 0x */
  s: { scalar: string };
  recovery_id: number;
}

export interface EvmSignature {
  r: Hex;
  s: Hex;
  yParity: 0 | 1;
  /** legacy v = 27 + yParity */
  v: 27n | 28n;
}

const HEX_32 = /^[0-9a-fA-F]{64}$/;

/** `{ big_r: { affine_point }, s: { scalar }, recovery_id }` -> `{ r, s, yParity, v }`. */
export function parseMpcSignature(raw: unknown): EvmSignature {
  const sig = raw as Partial<MpcSignatureRaw> | null;
  const point = sig?.big_r?.affine_point;
  const scalar = sig?.s?.scalar;
  const recoveryId = sig?.recovery_id;
  if (typeof point !== "string" || typeof scalar !== "string" || (recoveryId !== 0 && recoveryId !== 1)) {
    throw new Error(
      `Unexpected MPC signature shape ${JSON.stringify(raw)}; expected { big_r: { affine_point }, s: { scalar }, recovery_id: 0|1 }. ` +
        "Check that the call went to v1.signer with domain_id 0 (secp256k1).",
    );
  }
  const prefix = point.slice(0, 2);
  const x = point.slice(2);
  if ((prefix !== "02" && prefix !== "03") || !HEX_32.test(x) || !HEX_32.test(scalar)) {
    throw new Error(`MPC signature has a malformed big_r (${point}) or s (${scalar}); expected 33-byte compressed R and 32-byte s.`);
  }
  const r = `0x${x.toLowerCase()}` as const;
  const s = `0x${scalar.toLowerCase()}` as const;
  return { r, s, yParity: recoveryId, v: recoveryId === 0 ? 27n : 28n };
}
