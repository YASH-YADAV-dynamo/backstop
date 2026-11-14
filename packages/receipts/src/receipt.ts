/**
 * Plain-English rescue receipts from NEAR AI Cloud (OpenAI-compatible /chat/completions), with a
 * deterministic template fallback. Never throws and never takes longer than the timeout, so a
 * receipt can't block or fail a rescue.
 */
import { NEAR_AI, type Env } from "@backstop/config";
import type { RescueRecord } from "@backstop/core";
import { z } from "zod";
import { factsOf, factsText, templateReceipt } from "./facts.js";

export interface Receipt {
  text: string;
  source: "near-ai" | "template";
}

export interface ReceiptOptions {
  /** Default 15s. */
  timeoutMs?: number;
  baseUrl?: string;
}

export const SYSTEM_PROMPT =
  "You write receipts for an automated loan-protection service called Backstop. " +
  "Write exactly 3 plain-English sentences describing what happened, for the loan owner. " +
  "Use only the numbers given in the facts, written exactly as given; do not compute or invent any other number. " +
  "Do not give advice, predictions or recommendations. No lists, headings, markdown or emojis.";

const chatResponseSchema = z
  .object({
    choices: z
      .array(z.object({ message: z.object({ content: z.string() }).passthrough() }).passthrough())
      .min(1),
  })
  .passthrough();

/** Remove reasoning blocks (<think>...</think> etc., or everything before a dangling closing tag). */
export function stripReasoning(text: string): string {
  let out = text.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, "");
  const dangling = out.search(/<\/(think|thinking|reasoning)>/i);
  if (dangling >= 0) out = out.slice(out.indexOf(">", dangling) + 1);
  return out.replace(/\s+/g, " ").trim();
}

const NUMBER = /(?<![A-Za-z0-9.])\d+(?:\.\d+)?/g;

/** Returns the reason the text is not an acceptable receipt, or undefined if it is. */
export function rejectReason(text: string, facts: string): string | undefined {
  if (!text) return "empty";
  if (text.length > 700) return "too long";
  if (/[<>*#`]|^\s*[-•]/.test(text)) return "contains markup";
  if (!/[.!?]$/.test(text)) return "does not end with a sentence";
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z])/);
  if (sentences.length !== 3) return `has ${sentences.length} sentences, expected 3`;
  const allowed = new Set((facts.match(NUMBER) ?? []).map(Number));
  const foreign = (text.match(NUMBER) ?? []).filter((n) => !allowed.has(Number(n)));
  if (foreign.length) return `uses numbers not in the record: ${foreign.join(", ")}`;
  return undefined;
}

async function askNearAi(
  facts: string,
  apiKey: string,
  model: string,
  opts: ReceiptOptions,
): Promise<string> {
  const res = await fetch(`${(opts.baseUrl ?? NEAR_AI.baseUrl).replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 1024,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Facts:\n${facts}` },
      ],
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  });
  if (!res.ok) throw new Error(`NEAR AI returned HTTP ${res.status}`);
  const parsed = chatResponseSchema.parse(await res.json());
  return stripReasoning(parsed.choices[0]!.message.content);
}

/**
 * Write a 3-sentence receipt for a rescue. Uses NEAR AI when NEAR_AI_API_KEY is set and the
 * output passes validation (3 sentences, no markup, only numbers from the record); otherwise
 * returns the template receipt. `onFallback` (optional) receives why the AI text was not used.
 */
export async function writeReceipt(
  record: RescueRecord,
  env: Pick<Env, "NEAR_AI_API_KEY" | "NEAR_AI_MODEL">,
  opts: ReceiptOptions & { onFallback?: (reason: string) => void } = {},
): Promise<Receipt> {
  const fallback = (reason: string): void => {
    try {
      opts.onFallback?.(reason);
    } catch {
      // a logging callback must not turn a receipt into a failure
    }
  };
  const facts = factsOf(record);
  const template: Receipt = { text: templateReceipt(facts), source: "template" };
  if (!env.NEAR_AI_API_KEY) {
    fallback("NEAR_AI_API_KEY not set");
    return template;
  }
  const prompt = factsText(facts);
  try {
    const text = await askNearAi(prompt, env.NEAR_AI_API_KEY, env.NEAR_AI_MODEL, opts);
    const reject = rejectReason(text, prompt);
    if (reject) {
      fallback(`NEAR AI output rejected: ${reject}`);
      return template;
    }
    return { text, source: "near-ai" };
  } catch (err) {
    fallback(`NEAR AI call failed: ${err instanceof Error ? err.message : String(err)}`);
    return template;
  }
}
