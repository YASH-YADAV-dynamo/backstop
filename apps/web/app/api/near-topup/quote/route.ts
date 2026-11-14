import { handleTopUpQuote } from "@/lib/fund/near-topup";
import { realTopUpDeps } from "@/lib/fund/near-topup-deps";
import { PUBLIC_ENV } from "@/lib/public-env";
import { clientKey, createLimiter } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** Two quotes per top-up (a price check, then the real one): 10 per minute per IP, like /api/fund/quote. */
const limiter = createLimiter(10);
const headers = { "Cache-Control": "no-store" };

/** "Get NEAR": a signed, checked quote that swaps Base USDC or ETH into NEAR for the user's own account. Signs nothing, holds no key. */
export async function POST(request: Request) {
  if (!PUBLIC_ENV.getNearEnabled) return Response.json({ error: "Get NEAR is not turned on for this site." }, { status: 404, headers });
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
    result = await handleTopUpQuote(body, realTopUpDeps());
  } catch (err) {
    return Response.json({ error: `Server configuration problem: ${err instanceof Error ? err.message.split("\n")[0] : "unknown"}` }, { status: 500, headers });
  }
  return Response.json(result.body, { status: result.status, headers });
}
