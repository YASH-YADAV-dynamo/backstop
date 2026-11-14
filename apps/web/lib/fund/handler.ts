/**
 * POST /api/fund/quote logic (E.9), with every network dependency injected so the tests can run it
 * offline. The client chooses only {policy, originAsset, amount, refundTo}; recipient, destination
 * asset, swap type and refund type are fixed here and re-checked against what 1Click signed.
 */
import { canonicalQuote, verifyCanonicalQuote } from "@backstop/mover";
import { z } from "zod";
import { checkSignedFields, quoteRequestSchema, type OriginToken, type QuoteView } from "@/lib/fund/shared";
import { failedChecks, type Check } from "@/lib/policy-client";
import { redactUrls } from "@/lib/redact";

export type FundDeps = {
  tokens: () => Promise<OriginToken[]>;
  /** NEAR USDC asset id, already cross-checked against ONE_CLICK.expectedUsdcNearAssetId. */
  nearUsdcAssetId: () => Promise<string>;
  /** Throws when the policy does not exist or is not a v2 policy. */
  verifyPolicy: (policyId: string) => Promise<Check[]>;
  usdcRegistered: (policyId: string) => Promise<boolean>;
  /** POST /v0/quote; returns the raw parsed JSON. */
  requestQuote: (body: Record<string, unknown>) => Promise<unknown>;
  now: () => number;
  /** No 1Click key configured: 1Click adds 0.25%. */
  extraFee: boolean;
};

export type HandlerResult = { status: number; body: { error: string } | QuoteView };

const SLIPPAGE_BPS = 100;
const REQUEST_DEADLINE_MS = 30 * 60_000;

const rawQuoteSchema = z
  .object({
    signature: z.string().min(1),
    quote: z
      .object({
        depositAddress: z.string().min(1).max(200).regex(/^\S+$/),
        depositMemo: z.string().max(200).optional(),
      })
      .passthrough(),
  })
  .passthrough();

const fail = (status: number, error: string): HandlerResult => ({ status, body: { error } });

export async function handleQuote(input: unknown, deps: FundDeps): Promise<HandlerResult> {
  const parsed = quoteRequestSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return fail(400, `Bad request: ${first ? `${first.path.join(".") || "body"} ${first.message}` : "invalid body"}.`);
  }
  const req = parsed.data;

  try {
    const token = (await deps.tokens()).find((t) => t.assetId === req.originAsset);
    if (!token) return fail(400, "Bad request: originAsset is not a token 1Click currently supports. Reload the page to refresh the token list.");

    let checks: Check[];
    try {
      checks = await deps.verifyPolicy(req.policy);
    } catch (err) {
      return fail(404, `Could not read the policy ${req.policy} on NEAR: ${redactUrls(err instanceof Error ? err.message : String(err))}`);
    }
    const bad = failedChecks(checks);
    if (bad.length) return fail(409, `This policy is not safe to fund: ${bad.map((c) => c.label).join(", ")} failed verification. No deposit address was created.`);
    if (!(await deps.usdcRegistered(req.policy))) {
      return fail(409, "This policy is not registered on NEAR USDC yet, so a deposit could not be delivered. Make one deposit from the NEAR wallet tab first (it registers the policy), then fund from another chain.");
    }

    const destinationAsset = await deps.nearUsdcAssetId();
    const deadline = new Date(deps.now() + REQUEST_DEADLINE_MS).toISOString();
    const raw = await deps.requestQuote({
      dry: false,
      swapType: "EXACT_INPUT",
      slippageTolerance: SLIPPAGE_BPS,
      originAsset: req.originAsset,
      depositType: "ORIGIN_CHAIN",
      destinationAsset,
      amount: req.amount,
      refundTo: req.refundTo,
      refundType: "ORIGIN_CHAIN",
      recipient: req.policy,
      recipientType: "DESTINATION_CHAIN",
      deadline,
    });

    const shape = rawQuoteSchema.safeParse(raw);
    if (!shape.success) return fail(502, "1Click returned a quote without a deposit address or signature. No address is shown; try again.");
    const canonical = canonicalQuote(raw);
    if (!verifyCanonicalQuote(canonical, shape.data.signature)) {
      return fail(502, "The 1Click quote signature did not verify, so no deposit address is shown. Try again in a minute.");
    }
    const mismatches = checkSignedFields(
      canonical,
      { recipient: req.policy, destinationAsset, refundTo: req.refundTo, originAsset: req.originAsset, amount: req.amount },
      shape.data.quote.depositAddress,
      shape.data.quote.depositMemo,
    );
    if (mismatches.length) return fail(502, `The signed 1Click quote does not match your request (${mismatches.join("; ")}). No address is shown.`);

    // Read amounts from the SIGNED string, never from the unsigned fields.
    const signed = JSON.parse(canonical) as Record<string, unknown>;
    const amountIn = signed.amountIn;
    const minAmountOut = signed.minAmountOut;
    const signedDeadline = signed.deadline;
    if (amountIn !== req.amount || typeof minAmountOut !== "string" || !/^[1-9]\d*$/.test(minAmountOut) || typeof signedDeadline !== "string") {
      return fail(502, "The signed 1Click quote has unexpected amounts or no deadline. No address is shown.");
    }
    const deadlineMs = Date.parse(signedDeadline);
    if (!Number.isFinite(deadlineMs) || deadlineMs <= deps.now() + 5 * 60_000) {
      return fail(502, "The 1Click quote expires too soon to use. No address is shown; request a new quote.");
    }

    const view: QuoteView = {
      policy: req.policy,
      originAsset: req.originAsset,
      refundTo: req.refundTo,
      depositAddress: shape.data.quote.depositAddress,
      ...(shape.data.quote.depositMemo !== undefined && { depositMemo: shape.data.quote.depositMemo }),
      amountIn,
      minAmountOut,
      amountOutFormatted: typeof signed.amountOutFormatted === "string" ? signed.amountOutFormatted : "",
      deadline: signedDeadline,
      timeEstimate: typeof signed.timeEstimate === "number" ? signed.timeEstimate : 0,
      signature: shape.data.signature,
      canonical,
      extraFee: deps.extraFee,
    };
    return { status: 200, body: view };
  } catch (err) {
    return fail(502, `1Click could not give a quote: ${redactUrls(err instanceof Error ? err.message.split("\n")[0]! : String(err))}`);
  }
}
