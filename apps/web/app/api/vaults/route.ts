import { clientKey, createLimiter } from "@/lib/rate-limit";
import { handleCreate, handleGet } from "@/lib/vault-api";
import { realVaultDeps } from "@/lib/vault-api-deps";

export const dynamic = "force-dynamic";

const postLimiter = createLimiter(10);
const getLimiter = createLimiter(60);
const headers = { "Cache-Control": "no-store" };

const tooMany = () => Response.json({ error: "Too many requests. Wait a minute and try again." }, { status: 429, headers: { ...headers, "Retry-After": "60" } });

/** Vault creation requests: ?owner=<NEAR account> lists that owner's, ?vault=<vault account> shows one. Read-only. */
export async function GET(request: Request) {
  if (!getLimiter.allow(clientKey(request))) return tooMany();
  let result;
  try {
    result = await handleGet(new URL(request.url).searchParams, realVaultDeps());
  } catch (err) {
    return Response.json({ error: `Server configuration problem: ${err instanceof Error ? err.message.split("\n")[0] : "unknown"}` }, { status: 500, headers });
  }
  return Response.json(result.body, { status: result.status, headers });
}

/** Registers a vault account the user's wallet just created, for the bot to deploy into. Signs nothing, holds no key. */
export async function POST(request: Request) {
  if (!postLimiter.allow(clientKey(request))) return tooMany();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Bad request: the body must be JSON." }, { status: 400, headers });
  }
  let result;
  try {
    result = await handleCreate(body, realVaultDeps());
  } catch (err) {
    return Response.json({ error: `Server configuration problem: ${err instanceof Error ? err.message.split("\n")[0] : "unknown"}` }, { status: 500, headers });
  }
  return Response.json(result.body, { status: result.status, headers });
}
