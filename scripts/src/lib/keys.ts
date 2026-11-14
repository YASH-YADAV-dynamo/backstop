/** NEAR key helpers for the owner scripts. Only public keys are ever printed. */
import { KeyPair, type KeyPairString, type Provider } from "near-api-js";

/** `ed25519:...` public key of a private key from .env. */
export function publicKeyOf(privateKey: string): string {
  return KeyPair.fromString(privateKey as KeyPairString).getPublicKey().toString();
}

/**
 * Throws unless `privateKey` is a full-access key of `accountId` on chain. `envName` names the
 * .env variable in the error so the user knows which value to fix.
 */
export async function assertFullAccessKey(
  provider: Provider,
  accountId: string,
  privateKey: string,
  envName: string,
): Promise<void> {
  const publicKey = publicKeyOf(privateKey);
  let permission: unknown;
  try {
    ({ permission } = await provider.viewAccessKey({ accountId, publicKey }));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${envName} (public key ${publicKey}) is not an access key of ${accountId} (${reason}). ` +
        `Put a full-access key of ${accountId} in .env.`,
    );
  }
  if (permission !== "FullAccess") {
    throw new Error(
      `${envName} (public key ${publicKey}) is a function-call key of ${accountId}, not a full-access key. ` +
        `Put a full-access key of ${accountId} in .env.`,
    );
  }
}
