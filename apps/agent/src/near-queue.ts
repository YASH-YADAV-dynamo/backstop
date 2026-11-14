/**
 * One NEAR submit queue per bot key (design v3 1.1 "Nonces"). Vaults act in parallel, but every
 * transaction of the bot key goes through here: nonces are assigned locally under a mutex and the
 * signed tx is handed to the RPC (until INCLUDED) before the next one is signed, so two sends never
 * share a nonce and arrive in nonce order. Waiting for the execution result happens outside the mutex.
 * An InvalidNonce answer (the key was used elsewhere) re-reads the chain nonce and retries.
 */
import {
  KeyPairSigner,
  actions,
  baseDecode,
  baseEncode,
  createTransaction,
  getTransactionLastResult,
  teraToGas,
  type KeyPairString,
  type Provider,
} from "near-api-js";
import { InvalidNonceError, TransactionTimeoutError } from "near-api-js/rpc-errors";
import { sha256 } from "viem";
import { nearTxUrl } from "@backstop/config";
import { rpcErrorMessage, rpcErrors } from "@backstop/chains";

export interface NearCall {
  receiverId: string;
  methodName: string;
  args: Record<string, unknown>;
  tgas: number;
}

export interface NearCallResult {
  txHash: string;
  result: unknown;
}

/** What the queue needs from one NEAR key; live wiring below, fakes in tests. */
export interface NearKeyClient {
  /** The key's current nonce on chain. */
  chainNonce(): Promise<bigint>;
  /** Signs `call` with exactly `nonce` and hands it to the RPC; resolves with the tx hash once accepted. */
  submit(nonce: bigint, call: NearCall): Promise<string>;
  /** Waits until the tx executed; throws on failure. */
  result(txHash: string): Promise<unknown>;
}

const INVALID_NONCE = /InvalidNonce|invalid nonce/i;
export const isInvalidNonce = (err: unknown): boolean =>
  rpcErrors(err).some((e) => e instanceof InvalidNonceError || INVALID_NONCE.test(e instanceof Error ? `${e.name} ${e.message}` : String(e)));

/** Times a stale local nonce is re-read from chain before giving up on one call. */
const NONCE_RETRIES = 3;

export class NearSubmitQueue {
  private next: bigint | undefined;
  private lock: Promise<unknown> = Promise.resolve();

  constructor(private readonly key: NearKeyClient) {}

  /** Submits one function call; resolves with its tx hash and decoded result. */
  async call(call: NearCall): Promise<NearCallResult> {
    const txHash = await this.serial(() => this.submitWithNonce(call));
    return { txHash, result: await this.key.result(txHash) };
  }

  private async submitWithNonce(call: NearCall): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      if (this.next === undefined) this.next = (await this.key.chainNonce()) + 1n;
      const nonce = this.next;
      this.next = nonce + 1n; // consumed whatever happens: a gap is allowed on NEAR, a reuse is not
      try {
        return await this.key.submit(nonce, call);
      } catch (err) {
        if (!isInvalidNonce(err) || attempt >= NONCE_RETRIES) throw err;
        this.next = undefined; // someone else used the key: re-read the chain nonce
      }
    }
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn);
    this.lock = run.catch(() => undefined);
    return run;
  }
}

const POLL_DEADLINE_MS = 180_000;
const POLL_INTERVAL_MS = 3_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isTimeout = (err: unknown) => rpcErrors(err).some((e) => e instanceof TransactionTimeoutError);

/** A NearKeyClient over near-api-js for one account + private key. */
export function nearKeyClient(provider: Provider, accountId: string, privateKey: string): NearKeyClient {
  if (!/^(ed25519|secp256k1):/.test(privateKey)) throw new Error(`The private key for ${accountId} must look like "ed25519:..." Fix AGENT_PRIVATE_KEY.`);
  const signer = KeyPairSigner.fromSecretKey(privateKey as KeyPairString);
  return {
    chainNonce: async () => {
      const publicKey = await signer.getPublicKey();
      const key = await provider.viewAccessKey({ accountId, publicKey, finalityQuery: { finality: "optimistic" } });
      return BigInt(key.nonce);
    },
    submit: async (nonce, call) => {
      const publicKey = await signer.getPublicKey();
      const block = await provider.viewBlock({ finality: "final" });
      const tx = createTransaction(
        accountId,
        publicKey,
        call.receiverId,
        nonce,
        [actions.functionCall(call.methodName, call.args, teraToGas(call.tgas), 0n)],
        baseDecode(block.header.hash),
      );
      const { signedTransaction } = await signer.signTransaction(tx);
      const txHash = baseEncode(sha256(signedTransaction.transaction.encode(), "bytes"));
      try {
        await provider.sendTransactionUntil(signedTransaction, "INCLUDED");
      } catch (err) {
        // A wait timeout does not lose the tx: its hash is known and result() polls it.
        if (!isTimeout(err)) throw err;
      }
      return txHash;
    },
    result: async (txHash) => {
      const deadline = Date.now() + POLL_DEADLINE_MS;
      for (;;) {
        let outcome: Awaited<ReturnType<Provider["viewTransactionStatus"]>> | undefined;
        try {
          outcome = await provider.viewTransactionStatus({ txHash, accountId, waitUntil: "EXECUTED_OPTIMISTIC" });
        } catch (err) {
          // not executed yet (wait timed out) or not yet known to this node: keep polling
          if (!isTimeout(err) && !/UNKNOWN_TRANSACTION|doesn't exist|does not exist/i.test(rpcErrorMessage(err))) throw err;
        }
        const status = outcome?.status;
        if (outcome && typeof status === "object" && status !== null) {
          if ("Failure" in status) {
            throw new Error(`NEAR tx failed: ${JSON.stringify(status.Failure)}. See ${nearTxUrl(txHash)} and fix the cause before retrying.`);
          }
          return getTransactionLastResult(outcome);
        }
        if (Date.now() > deadline) throw new Error(`NEAR tx ${nearTxUrl(txHash)} did not finish within ${POLL_DEADLINE_MS / 1000}s. Check the link before retrying.`);
        await sleep(POLL_INTERVAL_MS);
      }
    },
  };
}
