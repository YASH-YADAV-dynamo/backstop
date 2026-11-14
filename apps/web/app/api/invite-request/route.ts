import { loadWebEnv } from "@backstop/config";
import { openInviteRequestStore, type InviteRequestStore } from "@backstop/db";
import { handleInviteRequest, handleInviteStatus, type InviteApiDeps } from "@/lib/invite-api";
import { clientKey, createLimiter } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const postLimiter = createLimiter(5);
const getLimiter = createLimiter(60);
const headers = { "Cache-Control": "no-store" };
const tooMany = () => Response.json({ error: "Too many requests. Wait a minute and try again." }, { status: 429, headers: { ...headers, "Retry-After": "60" } });

let store: Promise<InviteRequestStore> | undefined;
const deps = (): InviteApiDeps => ({
  store: () =>
    (store ??= openInviteRequestStore(loadWebEnv()).catch((err: unknown) => {
      store = undefined; // retry on the next request
      throw err;
    })),
  now: () => new Date(),
});

const failed = (err: unknown) =>
  Response.json({ error: `Could not save right now (${err instanceof Error ? err.message.split("\n")[0] : "unknown"}). Try again in a minute.` }, { status: 500, headers });

/** ?account=<NEAR account>: whether that account already asked for an invite. */
export async function GET(request: Request) {
  if (!getLimiter.allow(clientKey(request))) return tooMany();
  try {
    const r = await handleInviteStatus(new URL(request.url).searchParams, deps());
    return Response.json(r.body, { status: r.status, headers });
  } catch (err) {
    return failed(err);
  }
}

/** Saves an invite request. Grants nothing: invites are VAULT_ALLOWED_OWNERS, set by the operator. */
export async function POST(request: Request) {
  if (!postLimiter.allow(clientKey(request))) return tooMany();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Bad request: the body must be JSON." }, { status: 400, headers });
  }
  try {
    const r = await handleInviteRequest(body, deps());
    return Response.json(r.body, { status: r.status, headers });
  } catch (err) {
    return failed(err);
  }
}
