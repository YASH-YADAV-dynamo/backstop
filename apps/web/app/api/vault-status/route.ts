import { clientKey, createLimiter } from "@/lib/rate-limit";
import { BAD_POLICY_MESSAGE, parsePolicyParam } from "@/lib/policy-param";
import { readVaultStatus } from "@/lib/vault-status-source";

export const dynamic = "force-dynamic";

const limiter = createLimiter(60);
const headers = { "Cache-Control": "no-store" };

/** The rescue bot's latest check of one vault: `{ status, ageMs }`, or `{ status: null }` when the bot has none. Read-only. */
export async function GET(request: Request) {
  if (!limiter.allow(clientKey(request))) {
    return Response.json({ error: "Too many requests. Wait a minute and try again." }, { status: 429, headers: { ...headers, "Retry-After": "60" } });
  }
  const policy = parsePolicyParam(new URL(request.url).searchParams.get("policy"));
  if (policy === null || policy === undefined) {
    return Response.json({ error: policy === null ? BAD_POLICY_MESSAGE : "Add ?policy=<vault account>." }, { status: 400, headers });
  }
  try {
    return Response.json(await readVaultStatus(policy), { headers });
  } catch {
    // The store being down is "no proof of watching", never an error the app could mistake for health.
    return Response.json({ status: null, ageMs: null }, { headers });
  }
}
