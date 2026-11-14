/**
 * POST /api/near-topup/quote logic ("Get NEAR"), with every network dependency injected so the tests run offline.
 * The browser chooses only {originChain, originAsset, amount, recipient, refundTo, dry}. Destination asset,
 * recipient type, swap type and refund type are constants here, and the answer is refused unless the string
 * 1Click signed matches the request, the signature verifies, and the amounts are inside the limits.
 * Holds no key and signs nothing.
 */
import { canonicalQuote } from "@backstop/mover";
import { NEAR_TOPUP_DESTINATION, topUpOrigin } from "@backstop/config/near-topup";
import { z } from "zod";
import type { OriginToken } from "@/lib/fund/shared";
import { buildTopUpQuoteBody, checkTopUpQuote, limitsFor, topUpRequestSchema, type TopUpQuoteView } from "@/lib/fund/near-topup-shared";
import { redactUrls } from "@/lib/redact";

export type TopUpDeps = {
  /** Feature flag (NEXT_PUBLIC_GET_NEAR_ENABLED=1). Off = 404, nothing else runs. */
  enabled: boolean;
  /** 1Click /v0/tokens (cached). */
  tokens: () => Promise<OriginToken[]>;
  /** NEAR the account needs to create a vault (deposit + gas allowance); null while creation is not configured. */
  needYocto: () => bigint | null;
  /** Whether the NEAR account exists on chain (wNEAR cannot be delivered to an account that does not). */
  accountExists: (accountId: string) => Promise<boolean>;
  /** POST /v0/quote; returns the raw parsed JSON. */
  requestQuote: (body: Record<string, unknown>) => Promise<unknown>;
  /** ed25519 check of the canonical string against 1Click's quote-signing key. */
  verifySignature: (canonical: string, signature: string) => boolean;
  now: () => number;
  extraFee: boolean;
};

export type TopUpResult = { status: number; body: { error: string } | TopUpQuoteView };

const rawQuoteSchema = z
  .object({
    signature: z.string().min(1),
    quote: z
      .object({
        depositAddress: z.string().min(1).max(200).regex(/^\S+$/).optional(),
        depositMemo: z.string().max(200).optional(),
      })
      .passthrough(),
  })
  .passthrough();

const fail = (status: number, error: string): TopUpResult => ({ status, body: { error } });

export async function handleTopUpQuote(input: unknown, deps: TopUpDeps): Promise<TopUpResult> {
  if (!deps.enabled) return fail(404, "Get NEAR is not turned on for this site.");
  const parsed = topUpRequestSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return fail(400, `Bad request: ${first ? `${first.path.join(".") || "body"} ${first.message}` : "invalid body"}.`);
  }
  const req = parsed.data;
  const dry = req.dry === true;
  const origin = topUpOrigin(req.originChain)!;
  const allowed = origin.assets.find((a) => a.assetId === req.originAsset);
  if (!allowed) return fail(400, `Bad request: on ${origin.name} only ${origin.assets.map((a) => a.symbol).join(" or ")} can be swapped for NEAR.`);
  const need = deps.needYocto();
  if (need === null) return fail(409, "Vault creation is not open on this site yet, so there is nothing to get NEAR for.");

  try {
    const listed = (await deps.tokens()).find((t) => t.assetId === req.originAsset);
    if (!listed || listed.blockchain !== origin.oneClickChain || listed.decimals !== allowed.decimals) {
      return fail(503, `The swap service does not list ${allowed.symbol} on ${origin.name} as expected right now. Try again later.`);
    }
    if (!dry && NEAR_TOPUP_DESTINATION.delivery === "wrapped" && !(await deps.accountExists(req.recipient))) {
      return fail(409, `The NEAR account ${req.recipient} does not exist on chain yet, so wrapped NEAR cannot be delivered to it. Send a little NEAR to it first (for example from an exchange), then try again.`);
    }

    const raw = await deps.requestQuote(buildTopUpQuoteBody(req, deps.now()));
    const shape = rawQuoteSchema.safeParse(raw);
    if (!shape.success) return fail(502, "The swap service returned a quote without a signature. Nothing was created; try again.");
    if (!dry && !shape.data.quote.depositAddress) return fail(502, "The swap service returned a quote without a deposit address. Nothing was created; try again.");
    const canonical = canonicalQuote(raw);
    if (!deps.verifySignature(canonical, shape.data.signature)) {
      return fail(502, "The quote signature did not verify, so no deposit address is shown. Try again in a minute.");
    }
    const checked = checkTopUpQuote(
      canonical,
      { dry, recipient: req.recipient, refundTo: req.refundTo, originChain: req.originChain, originAsset: req.originAsset, amount: req.amount },
      { depositAddress: shape.data.quote.depositAddress, depositMemo: shape.data.quote.depositMemo },
      limitsFor(need),
      deps.now(),
    );
    if (!checked.ok) return fail(502, `The signed quote was refused (${checked.problems.join("; ")}). Nothing was sent. Change the amount or request a new quote.`);
    const v = checked.value;
    const view: TopUpQuoteView = {
      dry,
      recipient: req.recipient,
      originChain: req.originChain,
      originAsset: req.originAsset,
      refundTo: req.refundTo,
      destinationAsset: NEAR_TOPUP_DESTINATION.assetId,
      delivery: NEAR_TOPUP_DESTINATION.delivery,
      ...(v.depositAddress !== null && { depositAddress: v.depositAddress }),
      amountIn: v.amountIn,
      amountInUsd: v.amountInUsd,
      amountOut: v.amountOut,
      minAmountOut: v.minAmountOut,
      amountOutUsd: v.amountOutUsd,
      ...(v.deadline !== null && { deadline: v.deadline }),
      timeEstimate: v.timeEstimate,
      signature: shape.data.signature,
      canonical,
      extraFee: deps.extraFee,
    };
    return { status: 200, body: view };
  } catch (err) {
    return fail(502, `Could not get a quote from the swap service: ${redactUrls(err instanceof Error ? err.message.split("\n")[0]! : String(err))}. Try again in a minute.`);
  }
}
