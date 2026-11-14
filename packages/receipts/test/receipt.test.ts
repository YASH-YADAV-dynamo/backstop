import type { RescueRecord } from "@backstop/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rejectReason, stripReasoning, writeReceipt } from "../src/index.js";

const record: RescueRecord = {
  id: "r1",
  rescueId: 1,
  dryRun: false,
  triggeredAt: "2026-11-12T10:00:00.000Z",
  repayMinedAt: "2026-11-12T10:00:42.000Z",
  hfBefore: 1.2449,
  hfAfter: 1.5,
  amount: "3400341",
  status: "success",
  links: { baseRepayTx: "https://basescan.org/tx/0xabc" },
};
const env = { NEAR_AI_API_KEY: "sk-test", NEAR_AI_MODEL: "zai-org/GLM-5.1-FP8" };

const GOOD =
  "Backstop repaid 3.400341 USDC of your Aave v3 loan on Base when its health factor was 1.24. " +
  "After the repayment the health factor is 1.50. The rescue finished 42 seconds after it was triggered.";

const chat = (content: string, status = 200) =>
  new Response(JSON.stringify({ id: "x", choices: [{ index: 0, message: { role: "assistant", content } }] }), { status });

afterEach(() => vi.unstubAllGlobals());

describe("writeReceipt", () => {
  it("uses NEAR AI output when it is valid, stripping reasoning", async () => {
    const f = vi.fn<typeof fetch>().mockResolvedValue(chat(`<think>HF went from 1.24 to 1.5, maybe 99%?</think>\n${GOOD}`));
    vi.stubGlobal("fetch", f);
    const r = await writeReceipt(record, env);
    expect(r).toEqual({ text: GOOD, source: "near-ai" });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://cloud-api.near.ai/v1/chat/completions");
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
    const body = JSON.parse(init!.body as string);
    expect(body.model).toBe("zai-org/GLM-5.1-FP8");
    expect(body.messages[1].content).toContain("amount: 3.400341 USDC");
    expect(init!.signal).toBeInstanceOf(AbortSignal);
  });

  it("falls back to the template when the key is missing, without calling the API", async () => {
    const f = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", f);
    const r = await writeReceipt(record, { NEAR_AI_MODEL: env.NEAR_AI_MODEL });
    expect(r.source).toBe("template");
    expect(r.text).toBe(GOOD.replace(" v3", ""));
    expect(f).not.toHaveBeenCalled();
  });

  it("falls back to the template on HTTP errors", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(chat("", 500)));
    const reasons: string[] = [];
    const r = await writeReceipt(record, env, { onFallback: (why) => reasons.push(why) });
    expect(r.source).toBe("template");
    expect(reasons[0]).toMatch(/HTTP 500/);
  });

  it("falls back to the template on network errors and timeouts", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new DOMException("timed out", "TimeoutError")));
    await expect(writeReceipt(record, env)).resolves.toMatchObject({ source: "template" });
  });

  it("falls back when the response shape is wrong", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ choices: [] }))));
    await expect(writeReceipt(record, env)).resolves.toMatchObject({ source: "template" });
  });

  it("falls back when the model invents a number", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(chat(GOOD.replace("42 seconds", "40 seconds"))));
    const reasons: string[] = [];
    const r = await writeReceipt(record, env, { onFallback: (why) => reasons.push(why) });
    expect(r.source).toBe("template");
    expect(reasons[0]).toMatch(/numbers not in the record: 40/);
  });

  it("never throws, even if the fallback callback throws", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new Error("boom")));
    const r = await writeReceipt(record, env, {
      onFallback: () => {
        throw new Error("logger broke");
      },
    });
    expect(r.source).toBe("template");
  });

  it("template covers dry runs and failures in 3 sentences", async () => {
    const dry = await writeReceipt({ ...record, status: "dry-run", dryRun: true }, { NEAR_AI_MODEL: env.NEAR_AI_MODEL });
    expect(dry.text).toMatch(/dry run.*No funds were moved/);
    const failed = await writeReceipt({ ...record, status: "failed", error: "1Click refunded the deposit.\nstack..." }, { NEAR_AI_MODEL: env.NEAR_AI_MODEL });
    expect(failed.text).toContain("did not complete: 1Click refunded the deposit.");
    for (const t of [dry.text, failed.text]) expect(rejectReason(t, "3.400341 1.24 1.50 42 1")).toBeUndefined();
  });
});

describe("output validation", () => {
  it("rejects anything but exactly 3 sentences", () => {
    expect(rejectReason("One. Two.", "")).toMatch(/2 sentences/);
    expect(rejectReason("One. Two. Three. Four.", "")).toMatch(/4 sentences/);
    expect(rejectReason("One. Two. Three.", "")).toBeUndefined();
  });
  it("rejects markup", () => {
    expect(rejectReason("**One.** Two. Three.", "")).toMatch(/markup/);
  });
  it("strips a dangling closing think tag", () => {
    expect(stripReasoning("reasoning here</think>\n\nAnswer.")).toBe("Answer.");
  });
});
