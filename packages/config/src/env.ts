/**
 * Typed environment loading (Node only; client code imports `@backstop/config/registry`).
 *
 * - `loadEnv()` is for the agent and the operator scripts. It reads the repo-root .env.
 * - `loadWebEnv()` is for the web server. Its schema contains no secrets and it reads only the
 *   variables it names, so no private key ever reaches the web process through it.
 */
import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { FEE } from "./registry.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** NEAR account id rules (nomicon): 2-64 chars, lowercase parts separated by `.`, `-` or `_`. */
export const NEAR_ACCOUNT_ID_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export function isNearAccountId(value: string): boolean {
  return value.length >= 2 && value.length <= 64 && NEAR_ACCOUNT_ID_RE.test(value);
}

const nearAccount = z
  .string()
  .refine(isNearAccountId, "must be a NEAR account id like name.near (2-64 chars, lowercase)");
/** Comma-separated NEAR account ids (POLICY_CONTRACT_IDS). */
const nearAccountList = z
  .string()
  .refine((v) => splitList(v).every(isNearAccountId), "must be NEAR account ids separated by commas")
  .transform((v) => [...new Set(splitList(v))]);
const httpsUrl = z.string().refine(isHttpsUrl, "must be an https:// URL");
const nearKey = z.string().startsWith("ed25519:", "must be an ed25519 key like ed25519:...");

/** Comma-separated list of https URLs, as accepted in NEAR_RPC_URL / BASE_RPC_URL / ARBITRUM_RPC_URL. */
const rpcListValue = z
  .string()
  .refine(
    (v) => splitList(v).every(isHttpsUrl),
    "must be one or more https:// URLs separated by commas",
  );

/**
 * Variables Backstop v1 used that must not exist any more. The value is the message shown when one
 * is still set. Secrets fail the load (hard rule: no owner or policy key on any host).
 */
export const REMOVED_SECRET_VARS: Readonly<Record<string, string>> = {
  OWNER_PRIVATE_KEY:
    "OWNER_PRIVATE_KEY is no longer used; delete it from .env — Backstop v2 never needs your owner key",
  POLICY_CONTRACT_PRIVATE_KEY:
    "POLICY_CONTRACT_PRIVATE_KEY is no longer used; delete it from .env — v2 policy accounts have no keys at all",
};

const schema = z.object({
  POLICY_CONTRACT_ID: nearAccount.optional(),
  AGENT_ACCOUNT_ID: nearAccount.optional(),
  AGENT_PRIVATE_KEY: nearKey.optional(),
  NEAR_RPC_URL: rpcListValue.optional(),
  BASE_RPC_URL: rpcListValue.optional(),
  ARBITRUM_RPC_URL: rpcListValue.optional(),
  ONE_CLICK_JWT: z.string().optional(),
  NEAR_AI_API_KEY: z.string().optional(),
  NEAR_AI_MODEL: z.string().default("zai-org/GLM-5.1-FP8"),
  DATABASE_URL: z.string().optional(),
  RESCUES_FILE: z.string().default(join(REPO_ROOT, "rescues.json")),
  DEPLOYER_ACCOUNT_ID: nearAccount.optional(),
  DEPLOYER_PRIVATE_KEY: nearKey.optional(),
  FACTORY_CONTRACT_ID: nearAccount.optional(),
  /** Bot service: extra operator-made vaults to watch besides the factory's (comma-separated). */
  POLICY_CONTRACT_IDS: nearAccountList.optional(),
  /** Bot service: operator alerts (Discord/Slack-style JSON webhook). Optional. */
  ALERT_WEBHOOK_URL: httpsUrl.optional(),
  /** Bot service: dead-man's switch, fetched (GET) once per pass, e.g. a healthchecks.io URL. Optional. */
  HEARTBEAT_URL: httpsUrl.optional(),
  /** Bot status rows when DATABASE_URL is not set (JSON file). */
  VAULT_STATUS_FILE: z.string().default(join(REPO_ROOT, "vault-status.json")),
  /** NEAR account that receives the service fee (NEAR USDC) of policies this operator creates. */
  FEE_ACCOUNT_ID: nearAccount.optional(),
  /** Service fee in basis points of each bridged amount, 0..FEE.maxBps. */
  FEE_BPS: z.coerce.number().int().min(0).max(FEE.maxBps).default(FEE.defaultBps),
});

export type Env = z.infer<typeof schema>;

const webSchema = z.object({
  POLICY_CONTRACT_ID: nearAccount.optional(),
  NEAR_RPC_URL: rpcListValue.optional(),
  BASE_RPC_URL: rpcListValue.optional(),
  ARBITRUM_RPC_URL: rpcListValue.optional(),
  DATABASE_URL: z.string().optional(),
  RESCUES_FILE: z.string().default(join(REPO_ROOT, "rescues.json")),
  VAULT_STATUS_FILE: z.string().default(join(REPO_ROOT, "vault-status.json")),
});

export type WebEnv = z.infer<typeof webSchema>;

type Source = Record<string, string | undefined>;

function blankToUndefined(source: Source, keys: readonly string[]): Record<string, string | undefined> {
  return Object.fromEntries(keys.map((k) => [k, source[k] === "" ? undefined : source[k]]));
}

function parseOrThrow<T>(result: z.SafeParseReturnType<unknown, T>, what: string): T {
  if (result.success) return result.data;
  const issues = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
  throw new Error(`Invalid ${what}:\n${issues}\nFix the values (see .env.example for what each one is).`);
}

/**
 * Agent / scripts environment. Loads the repo-root .env into `process.env` first (when `source` is
 * omitted). Fails if a removed secret is still set.
 */
export function loadEnv(source?: Source): Env {
  let src = source;
  if (!src) {
    const envFile = join(REPO_ROOT, ".env");
    if (existsSync(envFile)) loadDotenv({ path: envFile, quiet: true });
    src = process.env;
  }
  const stillSet = Object.keys(REMOVED_SECRET_VARS).filter((k) => (src[k] ?? "") !== "");
  if (stillSet.length) throw new Error(stillSet.map((k) => REMOVED_SECRET_VARS[k]).join("\n"));
  return parseOrThrow(schema.safeParse(blankToUndefined(src, Object.keys(schema.shape))), ".env");
}

/**
 * Web server environment. Reads only the web variables from `source` (default
 * `process.env`); never loads .env itself and never reads a private key.
 */
export function loadWebEnv(source: Source = process.env): WebEnv {
  return parseOrThrow(
    webSchema.safeParse(blankToUndefined(source, Object.keys(webSchema.shape))),
    "web environment",
  );
}

/** Throws a clear error naming the missing variables and what they are for. */
export function requireEnv<K extends keyof Env>(env: Env, keys: K[], purpose: string): Env & Required<Pick<Env, K>> {
  const missing = keys.filter((k) => env[k] === undefined);
  if (missing.length) {
    throw new Error(`${purpose} needs ${missing.join(", ")} in .env (see .env.example for what each one is).`);
  }
  return env as Env & Required<Pick<Env, K>>;
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * RPC list = the env override URLs (comma-separated, tried first) followed by the built-in
 * defaults, de-duplicated. Throws if an override is not an https URL.
 */
export function rpcList(envValue: string | undefined, defaults: readonly string[]): string[] {
  const overrides = envValue ? splitList(envValue) : [];
  const bad = overrides.filter((u) => !isHttpsUrl(u));
  if (bad.length) throw new Error(`RPC URL(s) ${bad.join(", ")} are not https URLs; fix NEAR_RPC_URL / BASE_RPC_URL / ARBITRUM_RPC_URL.`);
  return [...new Set([...overrides, ...defaults])];
}

export const repoRoot = REPO_ROOT;
