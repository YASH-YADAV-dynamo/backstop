/**
 * JSON over fetch for the 1Click API: per-attempt timeout, retries with exponential backoff on
 * network errors and 5xx only, and zod validation of every response body.
 */
import { ONE_CLICK } from "@backstop/config";
import type { z } from "zod";

export interface OneClickOptions {
  /** 1Click JWT (env ONE_CLICK_JWT). Without it requests still work but pay an extra 0.25% fee. */
  jwt?: string | undefined;
  baseUrl?: string;
  /** Per-attempt timeout. Default 20s. */
  timeoutMs?: number;
  /** Extra attempts after the first on network errors / 5xx. Default 3. */
  retries?: number;
  /** First backoff delay; doubles each retry. Default 500ms. */
  backoffMs?: number;
}

export class OneClickError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "OneClickError";
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const baseUrlOf = (opts: OneClickOptions): string => (opts.baseUrl ?? ONE_CLICK.baseUrl).replace(/\/$/, "");

/** Validated JSON response. */
export async function requestJson<S extends z.ZodTypeAny>(
  path: string,
  schema: S,
  init: { method: "GET" | "POST"; body?: unknown },
  opts: OneClickOptions = {},
): Promise<z.output<S>> {
  return (await requestRaw(path, schema, init, opts)).data;
}

/**
 * Like requestJson, but also returns the untransformed parsed JSON. The signed 1Click quote
 * string must be rebuilt from the original strings, not from the zod output (bigints).
 */
export async function requestRaw<S extends z.ZodTypeAny>(
  path: string,
  schema: S,
  init: { method: "GET" | "POST"; body?: unknown },
  opts: OneClickOptions = {},
): Promise<{ data: z.output<S>; raw: unknown }> {
  const url = `${baseUrlOf(opts)}${path}`;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const retries = opts.retries ?? 3;
  const backoffMs = opts.backoffMs ?? 500;
  const headers: Record<string, string> = { accept: "application/json" };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (opts.jwt) headers["X-API-Key"] = opts.jwt;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(backoffMs * 2 ** (attempt - 1));
    let res: Response;
    try {
      res = await fetch(url, {
        method: init.method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      lastError = err;
      continue;
    }
    const text = await res.text();
    if (res.status >= 500) {
      lastError = new OneClickError(`1Click ${init.method} ${path} returned HTTP ${res.status}`, res.status, text);
      continue;
    }
    if (!res.ok) {
      throw new OneClickError(
        `1Click ${init.method} ${path} rejected the request (HTTP ${res.status}): ${text.slice(0, 500)}. ` +
          "Check the request parameters; a 401 means ONE_CLICK_JWT is invalid (remove it to use the keyless tier).",
        res.status,
        text,
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new OneClickError(`1Click ${init.method} ${path} returned non-JSON: ${text.slice(0, 200)}`, res.status, text);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      throw new OneClickError(
        `1Click ${init.method} ${path} response failed validation (${issues}). ` +
          "The API may have changed: compare with the OpenAPI spec before moving funds.",
        res.status,
        text,
      );
    }
    return { data: parsed.data, raw: json };
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new OneClickError(
    `1Click ${init.method} ${path} failed after ${retries + 1} attempts: ${reason}. Check network access to ${baseUrlOf(opts)} and retry.`,
    lastError instanceof OneClickError ? lastError.status : undefined,
    lastError instanceof OneClickError ? lastError.body : undefined,
  );
}

/** Options from .env: sends X-API-Key only when ONE_CLICK_JWT is set. */
export const oneClickOptionsFromEnv = (env: { ONE_CLICK_JWT?: string | undefined }): OneClickOptions => ({
  jwt: env.ONE_CLICK_JWT,
});
