import { cachedStatus, DEPOSIT_ADDRESS_RE, statusError } from "@/lib/fund/status";
import { clientKey, createLimiter } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const limiter = createLimiter(60);
const headers = { "Cache-Control": "no-store" };

/** Progress of a 1Click deposit address. Read-only proxy of GET /v0/status. */
export async function GET(request: Request) {
  if (!limiter.allow(clientKey(request))) {
    return Response.json({ error: "Too many status requests. Wait a minute." }, { status: 429, headers });
  }
  const address = new URL(request.url).searchParams.get("depositAddress") ?? "";
  if (!DEPOSIT_ADDRESS_RE.test(address)) {
    return Response.json({ error: "depositAddress must be 8-128 letters, digits or . _ : -" }, { status: 400, headers });
  }
  try {
    return Response.json(await cachedStatus(address), { headers });
  } catch (err) {
    return Response.json({ error: `Could not read the deposit status from 1Click: ${statusError(err)}` }, { status: 502, headers });
  }
}
