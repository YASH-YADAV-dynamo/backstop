import { describe, expect, it } from "vitest";
import { keccak256, recoverAddress, toHex } from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";
// Imports the module directly so this pure test does not load chainsig.js.
import { parseMpcSignature } from "../src/mpc-signature.js";

// Throwaway test key (never funded).
const privateKey = keccak256(toHex("backstop parseMpcSignature test key"));
const account = privateKeyToAccount(privateKey);
const hash = keccak256(toHex("payload"));

/** Shapes a local secp256k1 signature the way v1.signer returns it. */
async function mpcShaped() {
  const { r, s, yParity } = await sign({ hash, privateKey });
  if (yParity === undefined) throw new Error("viem sign returned no yParity");
  return {
    raw: {
      big_r: { affine_point: `${yParity === 0 ? "02" : "03"}${r.slice(2).toUpperCase()}` },
      s: { scalar: s.slice(2) },
      recovery_id: yParity,
    },
    r,
    s,
    yParity,
  };
}

describe("parseMpcSignature", () => {
  it("turns big_r/s/recovery_id into r/s/yParity that recover to the signer", async () => {
    const { raw, r, s, yParity } = await mpcShaped();
    const parsed = parseMpcSignature(raw);
    expect(parsed).toEqual({ r, s, yParity, v: yParity === 0 ? 27n : 28n });
    expect(await recoverAddress({ hash, signature: { r: parsed.r, s: parsed.s, yParity: parsed.yParity } })).toBe(account.address);
  });

  it("rejects malformed responses", async () => {
    const { raw } = await mpcShaped();
    expect(() => parseMpcSignature({ ...raw, recovery_id: 2 })).toThrow(/recovery_id/);
    expect(() => parseMpcSignature({ ...raw, big_r: { affine_point: `04${raw.big_r.affine_point.slice(2)}` } })).toThrow(/malformed/);
    expect(() => parseMpcSignature({ big_r: "02ab", s: "cd", recovery_id: 0 })).toThrow(/Unexpected MPC signature shape/);
  });
});
