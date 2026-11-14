/** NEAR reads and transactions via near-api-js 7. */
import {
  Account,
  FailoverRpcError,
  FailoverRpcProvider,
  JsonRpcProvider,
  KeyPairSigner,
  actions,
  baseEncode,
  getTransactionLastResult,
  teraToGas,
  type Action,
  type KeyPairString,
  type Provider,
} from "near-api-js";
import { TransactionTimeoutError } from "near-api-js/rpc-errors";
import { sha256 } from "viem";
import { nearTxUrl } from "@backstop/config";

export type NearTxOutcome = Awaited<ReturnType<Account["signAndSendTransaction"]>>;

export interface NearTxResult {
  /** base58 NEAR tx hash */
  txHash: string;
  outcome: NearTxOutcome;
}

const DEFAULT_GAS = teraToGas(30);
const ONE_YOCTO = 1n;
/** How long to keep polling a tx whose RPC wait timed out (MPC signing can take a while). */
const POLL_DEADLINE_MS = 180_000;
const POLL_INTERVAL_MS = 3_000;

/** Attempts per endpoint before failing over to the next one (near-api-js defaults to 12). */
const RPC_ATTEMPTS_PER_URL = 3;

/** Called once per failed attempt before the next URL is tried. Default: one line on stderr. */
export type OnFailover = (url: string, err: unknown) => void;

const firstLine = (err: unknown) => (err instanceof Error ? err.message : String(err)).split("\n")[0]!.slice(0, 200);
const defaultOnFailover: OnFailover = (url, err) => console.warn(`NEAR RPC ${url} failed (${firstLine(err)}); trying the next one.`);

/**
 * near-api-js 7.5.3's FailoverRpcProvider prints the full error object (with stack) to stderr on
 * every failed attempt. Same failover order, but one line per failed attempt via `onFailover`.
 * `withBackoff` is private in its typings, so it is replaced on the subclass prototype.
 */
/**
 * An answer from a healthy node that another node would give too (missing account / key / code,
 * a contract panic, an invalid tx). Failing over on these only hides the real message behind
 * "Exceeded N providers", so they are thrown at once, unwrapped.
 */
const DEFINITIVE =
  /does not exist|UNKNOWN_ACCOUNT|UNKNOWN_ACCESS_KEY|access key .* does not exist|MethodNotFound|CodeDoesNotExist|NO_CONTRACT_CODE|CONTRACT_EXECUTION_ERROR|FunctionCallError|wasm execution failed|Smart contract panicked|InvalidTransaction|ActionError|InvalidNonce|NotEnoughBalance/i;
export const isDefinitiveRpcError = (err: unknown): boolean => {
  const text = err instanceof Error ? `${err.name} ${err.message} ${String((err as { type?: unknown }).type ?? "")}` : String(err);
  return DEFINITIVE.test(text);
};

class QuietFailoverRpcProvider extends FailoverRpcProvider {
  constructor(
    providers: JsonRpcProvider[],
    readonly urls: string[],
    readonly onFailover: OnFailover,
  ) {
    super(providers);
  }
}
Object.defineProperty(QuietFailoverRpcProvider.prototype, "withBackoff", {
  value: async function withBackoff<T>(this: QuietFailoverRpcProvider & { index?: number }, getResult: (p: Provider) => Promise<T>) {
    const errors: unknown[] = [];
    const n = this.providers.length;
    for (let i = 0; i < n; i++) {
      const at = this.index ?? 0;
      try {
        return await getResult(this.providers[at]!);
      } catch (err) {
        if (isDefinitiveRpcError(err)) throw err;
        errors.push(err);
        if (i < n - 1) this.onFailover(this.urls[at] ?? `#${at}`, err);
        this.index = (at + 1) % n;
      }
    }
    throw new FailoverRpcError(n, errors as Error[]);
  },
});

/**
 * A provider over one or more NEAR RPC URLs, tried in order. Every call fails over, including
 * `sendTransactionUntil` and `viewTransactionStatus` (it re-sends the same signed tx, which NEAR
 * deduplicates by hash). Errors come back as FailoverRpcError: unwrap with `rpcErrors`.
 */
export function nearProvider(urls: string | readonly string[], onFailover: OnFailover = defaultOnFailover): Provider {
  const list = typeof urls === "string" ? [urls] : [...urls];
  if (list.length === 0) throw new Error("No NEAR RPC URL configured. Set NEAR_RPC_URL or use the built-in list.");
  return new QuietFailoverRpcProvider(
    list.map((url) => new JsonRpcProvider({ url }, { retries: RPC_ATTEMPTS_PER_URL, wait: 500, backoff: 2 })),
    list,
    onFailover,
  );
}

/** The errors behind a failed call: FailoverRpcProvider wraps them in FailoverRpcError. */
export function rpcErrors(err: unknown): unknown[] {
  return err instanceof FailoverRpcError ? [...err.errors] : [err];
}

/** The first underlying error message, for messages shown to the operator. */
export function rpcErrorMessage(err: unknown): string {
  const first = rpcErrors(err)[0];
  return first instanceof Error ? first.message : String(first);
}

const isTimeout = (err: unknown) => rpcErrors(err).some((e) => e instanceof TransactionTimeoutError);

/** An Account that signs with the given full-access or function-call key. */
export function nearAccount(accountId: string, privateKey: string, rpcUrls: string | readonly string[]): Account {
  if (!/^(ed25519|secp256k1):/.test(privateKey)) {
    throw new Error(`The private key for ${accountId} must look like "ed25519:..." Fix it in .env.`);
  }
  const signer = KeyPairSigner.fromSecretKey(privateKey as KeyPairString);
  return new Account(accountId, nearProvider(rpcUrls), signer);
}

/** `view_access_key_list`: every access key on the account (a keyless policy has none). */
export async function viewAccessKeys(provider: Provider, accountId: string): Promise<{ publicKey: string; fullAccess: boolean }[]> {
  let list;
  try {
    list = await provider.viewAccessKeyList({ accountId, finalityQuery: { finality: "final" } });
  } catch (err) {
    throw new Error(`Could not list access keys of ${accountId}: ${rpcErrorMessage(err)}. Check the account id and NEAR_RPC_URL.`);
  }
  if (list.last_key) {
    throw new Error(`${accountId} has more access keys than one RPC page; treat it as not keyless.`);
  }
  return list.keys.map((k) => ({ publicKey: String(k.public_key), fullAccess: k.access_key.permission === "FullAccess" }));
}

/** Calls a view method and returns its JSON result. */
export async function viewCall<T>(
  provider: Provider,
  contractId: string,
  method: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  let result: unknown;
  try {
    result = await provider.callFunction({ contractId, method, args });
  } catch (err) {
    throw new Error(`View ${contractId}.${method} failed: ${rpcErrorMessage(err)}. Check the account id and NEAR_RPC_URL.`);
  }
  if (result === undefined) {
    throw new Error(`View ${contractId}.${method} returned nothing. Check that ${contractId} has a contract deployed.`);
  }
  return result as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function assertSuccess(outcome: NearTxOutcome, txHash: string): void {
  const status = outcome.status;
  if (typeof status === "object" && status !== null && "Failure" in status) {
    throw new Error(
      `NEAR tx failed: ${JSON.stringify(status.Failure)}. See ${nearTxUrl(txHash)} for details and fix the cause before retrying.`,
    );
  }
}

/**
 * Signs and sends one transaction and waits until it is executed. Unlike
 * Account.signAndSendTransaction, an RPC wait timeout does not lose the tx: we know the
 * hash up front and keep polling its status.
 */
export async function sendTransaction(account: Account, receiverId: string, txActions: Action[]): Promise<NearTxResult> {
  const signed = await account.createSignedTransaction({ receiverId, actions: txActions });
  const txHash = baseEncode(sha256(signed.transaction.encode(), "bytes"));
  let outcome: NearTxOutcome;
  try {
    outcome = await account.provider.sendTransactionUntil(signed, "EXECUTED_OPTIMISTIC");
  } catch (err) {
    if (!isTimeout(err)) throw new Error(`NEAR rejected or failed ${nearTxUrl(txHash)}: ${rpcErrorMessage(err)}`);
    outcome = await pollUntilExecuted(account, txHash);
  }
  assertSuccess(outcome, txHash);
  return { txHash, outcome };
}

async function pollUntilExecuted(account: Account, txHash: string): Promise<NearTxOutcome> {
  const deadline = Date.now() + POLL_DEADLINE_MS;
  while (Date.now() < deadline) {
    try {
      const outcome = await account.provider.viewTransactionStatus({
        txHash,
        accountId: account.accountId,
        waitUntil: "EXECUTED_OPTIMISTIC",
      });
      const status = outcome.status;
      if (typeof status === "object" && status !== null) return outcome;
    } catch (err) {
      if (!isTimeout(err)) throw new Error(`Status of ${nearTxUrl(txHash)} unavailable: ${rpcErrorMessage(err)}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`NEAR tx ${nearTxUrl(txHash)} did not finish within ${POLL_DEADLINE_MS / 1000}s. Check the link before retrying.`);
}

export interface FunctionCallArgs {
  contractId: string;
  methodName: string;
  args?: Record<string, unknown>;
  /** gas units (use teraToGas); default 30 TGas */
  gas?: bigint;
  /** yoctoNEAR; default 0 */
  deposit?: bigint;
}

/** Change-method call; returns the tx hash and the decoded return value. */
export async function functionCall(
  account: Account,
  { contractId, methodName, args = {}, gas = DEFAULT_GAS, deposit = 0n }: FunctionCallArgs,
): Promise<NearTxResult & { result: unknown }> {
  const sent = await sendTransaction(account, contractId, [actions.functionCall(methodName, args, gas, deposit)]);
  return { ...sent, result: getTransactionLastResult(sent.outcome) };
}

/** NEP-141 `ft_balance_of`. */
export async function ftBalance(provider: Provider, token: string, accountId: string): Promise<bigint> {
  const balance = await viewCall<string>(provider, token, "ft_balance_of", { account_id: accountId });
  return BigInt(balance);
}

export interface FtTransferArgs {
  token: string;
  receiverId: string;
  /** token smallest unit */
  amount: bigint;
  memo?: string;
}

/**
 * NEP-141 `ft_transfer` with 1 yoctoNEAR. If the receiver has no storage on the token
 * (`storage_balance_of` is null), a `storage_deposit` for the token's minimum is added to
 * the same transaction, so registration and transfer are atomic.
 */
export async function ftTransfer(
  account: Account,
  { token, receiverId, amount, memo }: FtTransferArgs,
): Promise<NearTxResult & { registeredReceiver: boolean }> {
  if (amount <= 0n) throw new Error("ftTransfer amount must be > 0.");
  const balance = await ftBalance(account.provider, token, account.accountId);
  if (balance < amount) {
    throw new Error(`${account.accountId} holds ${balance} of ${token}, needs ${amount}. Top up the account and retry.`);
  }
  const storage = await account.provider.callFunction({
    contractId: token,
    method: "storage_balance_of",
    args: { account_id: receiverId },
  });
  const txActions: Action[] = [];
  const needsStorage = storage === null || storage === undefined;
  if (needsStorage) {
    const bounds = await viewCall<{ min: string }>(account.provider, token, "storage_balance_bounds");
    txActions.push(
      actions.functionCall(
        "storage_deposit",
        { account_id: receiverId, registration_only: true },
        DEFAULT_GAS,
        BigInt(bounds.min),
      ),
    );
  }
  txActions.push(
    actions.functionCall(
      "ft_transfer",
      { receiver_id: receiverId, amount: amount.toString(), ...(memo ? { memo } : {}) },
      DEFAULT_GAS,
      ONE_YOCTO,
    ),
  );
  const sent = await sendTransaction(account, token, txActions);
  return { ...sent, registeredReceiver: needsStorage };
}
