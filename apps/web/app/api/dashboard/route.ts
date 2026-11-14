import type { DashboardSnapshot } from "@/lib/dashboard-types";
import { getDashboard } from "@/lib/data";
import { BAD_POLICY_MESSAGE, parsePolicyParam } from "@/lib/policy-param";

export const dynamic = "force-dynamic";

const TTL_MS = 10_000;
const MAX_ENTRIES = 100;
const DEFAULT_KEY = "";
const cache = new Map<string, { at: number; pending: Promise<DashboardSnapshot> }>();

/** One in-flight/recent snapshot per policy id: 10 s TTL, at most 100 ids (oldest evicted). */
function cached(policy: string | undefined): Promise<DashboardSnapshot> {
  const key = policy ?? DEFAULT_KEY;
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < TTL_MS) return hit.pending;
  cache.delete(key);
  while (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  const pending = getDashboard(policy);
  cache.set(key, { at: now, pending });
  // Do not keep a rejected promise around.
  pending.catch(() => cache.delete(key));
  return pending;
}

/** JSON snapshot (policy, position, history). `?policy=<NEAR account id>` selects a policy; default is the server's POLICY_CONTRACT_ID. Read-only. */
export async function GET(request: Request) {
  const policy = parsePolicyParam(new URL(request.url).searchParams.get("policy"));
  if (policy === null) {
    return Response.json({ error: BAD_POLICY_MESSAGE }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  return Response.json(await cached(policy), { headers: { "Cache-Control": "no-store" } });
}
