import { handleQuote } from "@/lib/fund/handler";
import { realDeps } from "@/lib/fund/server-deps";
import { clientKey, createLimiter } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const limiter = createLimiter(10);
const headers = { "Cache-Control": "no-store" };

/** Ask 1Click for a deposit address that pays NEAR USDC into the given policy. Signs nothing, holds no key. */
export async function POST(request: Request) {
  if (!limiter.allow(clientKey(request))) {
    return Response.json({ error: "Too many quote requests. Wait a minute and try again." }, { status: 429, headers });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Bad request: the body must be JSON." }, { status: 400, headers });
  }
  let result;
  try {
    result = await handleQuote(body, realDeps());
  } catch (err) {
    return Response.json({ error: `Server configuration problem: ${err instanceof Error ? err.message.split("\n")[0] : "unknown"}` }, { status: 500, headers });
  }
  return Response.json(result.body, { status: result.status, headers });
}
