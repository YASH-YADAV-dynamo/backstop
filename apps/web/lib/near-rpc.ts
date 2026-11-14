/**
 * Minimal NEAR JSON-RPC client for the browser (fetch only, no near-api-js in the bundle).
 * Tries every URL in `NEAR.rpcUrls` (or the server override) in order (3 endpoints, 10 s each). Reads never go through the
 * user's wallet: a wallet on the wrong network or with a lying RPC must not change what we show.
 */
import { NEAR } from "@backstop/config/registry";
import { z } from "zod";

const TIMEOUT_MS = 10_000;

let rpcUrls: readonly string[] = NEAR.rpcUrls;
/** Server only: put the operator's NEAR_RPC_URL override in front of the built-in list. The browser always uses the public list. */
export function configureNearRpc(urls: readonly string[]): void {
  rpcUrls = urls;
}

/** Raised when every endpoint failed, or an endpoint gave a definitive answer that is an error. */
export class NearRpcError extends Error {
  constructor(
    message: string,
    readonly kind: "unreachable" | "rejected",
  ) {
    super(message);
    this.name = "NearRpcError";
  }
}

const envelope = z.object({
  result: z.unknown().optional(),
  error: z
    .object({ name: z.string().optional(), message: z.string().optional(), cause: z.object({ name: z.string().optional() }).passthrough().optional(), data: z.unknown().optional() })
    .passthrough()
    .optional(),
});

/** JSON-RPC errors that describe the request, not the endpoint: another endpoint would say the same. */
const DEFINITIVE = new Set(["UNKNOWN_ACCOUNT", "UNKNOWN_TRANSACTION", "INVALID_TRANSACTION", "UNKNOWN_BLOCK", "NO_SYNCED_BLOCKS", "TIMEOUT_ERROR"]);

async function post(url: string, body: unknown): Promise<z.infer<typeof envelope>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
      cache: "no-store",
    });
    if (!res.ok) throw new Error(res.status === 429 ? "rate limited (429)" : `HTTP ${res.status}`);
    return envelope.parse(await res.json());
  } finally {
    clearTimeout(timer);
  }
}

/** One RPC method with failover. Returns the raw `result`; the caller validates it with zod. */
export async function nearRpc(method: string, params: unknown): Promise<unknown> {
  const failures: string[] = [];
  for (const url of rpcUrls) {
    try {
      const res = await post(url, { jsonrpc: "2.0", id: "backstop", method, params });
      if (res.error) {
        const cause = res.error.cause?.name ?? res.error.name ?? "";
        if (DEFINITIVE.has(cause)) throw new NearRpcError(`${cause}: ${res.error.message ?? ""}`.trim(), "rejected");
        throw new Error(`${cause || "RPC error"} ${res.error.message ?? ""}`.trim());
      }
      return res.result;
    } catch (err) {
      if (err instanceof NearRpcError) throw err;
      const host = new URL(url).hostname;
      failures.push(`${host}: ${err instanceof Error ? (err.name === "AbortError" ? "timed out" : err.message) : String(err)}`);
    }
  }
  throw new NearRpcError(
    `NEAR network unreachable (${failures.join("; ")}). Check your connection and retry.`,
    "unreachable",
  );
}

const callResult = z.union([
  z.object({ result: z.array(z.number().int().min(0).max(255)) }),
  z.object({ error: z.string() }),
]);

/** Call a view method and parse its JSON answer with `schema`. */
export async function viewFunction<T>(
  contractId: string,
  methodName: string,
  args: Record<string, unknown>,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
): Promise<T> {
  const raw = await nearRpc("query", {
    request_type: "call_function",
    finality: "final",
    account_id: contractId,
    method_name: methodName,
    args_base64: btoa(JSON.stringify(args)),
  });
  const parsed = callResult.parse(raw);
  if ("error" in parsed) {
    throw new NearRpcError(`${contractId}.${methodName} failed: ${parsed.error.split("\n")[0] ?? parsed.error}`, "rejected");
  }
  const text = new TextDecoder().decode(Uint8Array.from(parsed.result));
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new NearRpcError(`${contractId}.${methodName} did not return JSON.`, "rejected");
  }
  const checked = schema.safeParse(json);
  if (!checked.success) {
    const where = checked.error.issues[0]?.path.join(".") || "response";
    throw new NearRpcError(
      `${contractId}.${methodName} answered with an unexpected shape (${where}). It may not be the contract you expect.`,
      "rejected",
    );
  }
  return checked.data;
}

const viewAccountSchema = z.union([
  z.object({ amount: z.string(), locked: z.string(), code_hash: z.string(), storage_usage: z.number() }).passthrough(),
  z.object({ error: z.string() }).passthrough(),
]);

export type AccountInfo = { amount: bigint; codeHash: string; storageUsage: number };

/** `null` when the account does not exist. */
export async function viewAccount(accountId: string): Promise<AccountInfo | null> {
  try {
    const raw = viewAccountSchema.parse(await nearRpc("query", { request_type: "view_account", finality: "final", account_id: accountId }));
    if ("error" in raw) {
      if (/does not exist/i.test(String(raw.error))) return null;
      throw new NearRpcError(String(raw.error), "rejected");
    }
    return { amount: BigInt(raw.amount), codeHash: raw.code_hash, storageUsage: raw.storage_usage };
  } catch (err) {
    if (err instanceof NearRpcError && err.message.startsWith("UNKNOWN_ACCOUNT")) return null;
    throw err;
  }
}

const accessKeysSchema = z.union([z.object({ keys: z.array(z.unknown()) }), z.object({ error: z.string() }).passthrough()]);

/** Number of access keys on the account (a policy must have none). */
export async function accessKeyCount(accountId: string): Promise<number> {
  const raw = accessKeysSchema.parse(await nearRpc("query", { request_type: "view_access_key_list", finality: "final", account_id: accountId }));
  if ("error" in raw) throw new NearRpcError(raw.error, "rejected");
  return raw.keys.length;
}

const txStatusSchema = z
  .object({
    status: z.unknown(),
    transaction: z.object({ hash: z.string() }).passthrough(),
    receipts_outcome: z.array(z.object({ outcome: z.object({ status: z.unknown() }).passthrough() }).passthrough()).default([]),
  })
  .passthrough();

export type TxResult = { hash: string; failure: string | null };

/** Final result of a transaction, or `null` while the network does not know it yet / still executes it. */
export async function txResult(txHash: string, signerId: string): Promise<TxResult | null> {
  try {
    const raw = await nearRpc("tx", { tx_hash: txHash, sender_account_id: signerId, wait_until: "FINAL" });
    if (raw === undefined || raw === null) return null;
    const parsed = txStatusSchema.parse(raw);
    return { hash: parsed.transaction.hash, failure: findFailure(parsed) };
  } catch (err) {
    if (err instanceof NearRpcError && err.kind === "rejected") return null;
    throw err;
  }
}

/** First `Failure` in a transaction outcome (the final status or any receipt), as readable text. */
export function findFailure(outcome: { status?: unknown; receipts_outcome?: Array<{ outcome: { status?: unknown } }> }): string | null {
  const statuses = [outcome.status, ...(outcome.receipts_outcome ?? []).map((r) => r.outcome.status)];
  for (const s of statuses) {
    if (s && typeof s === "object" && "Failure" in s) return failureText((s as { Failure: unknown }).Failure);
  }
  return null;
}

function failureText(failure: unknown): string {
  const text = JSON.stringify(failure);
  // Contract panics look like {"ActionError":{"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: ERR_..."}}}}
  const m = /Smart contract panicked: ([^"\\]+(?:\\.[^"\\]*)*)/.exec(text);
  return m?.[1] ? m[1].replace(/\\"/g, '"') : text;
}
