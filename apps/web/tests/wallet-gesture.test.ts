import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * iOS Safari and popup blockers drop a wallet popup opened after an `await` in a click handler (row 24).
 * These handlers must reach the wallet call synchronously; this keeps it that way.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** Source from `start` up to the first wallet call `call`. */
function before(source: string, start: string, call: string): string {
  const from = source.indexOf(start);
  expect(from, `${start} not found`).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(call, from);
  expect(to, `${call} not found after ${start}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe("no await before a wallet call in click handlers", () => {
  const provider = read("../components/wallet/near-provider.tsx");
  const review = read("../components/wallet/review-dialog.tsx");
  const evmConnect = read("../components/wallet/evm-connect-dialog.tsx");
  const cases: Array<[string, string]> = [
    ["NEAR connect", before(provider, "const connect = useCallback(", "connector.connect()")],
    ["NEAR send", before(provider, "const send = useCallback(", "wallet.signAndSendTransaction(")],
    ["review confirm (NEAR)", before(review, "function confirm()", ".send({")],
    ["review confirm (EVM)", before(review, "function confirm()", "sendEth(")],
    ["EVM connect", before(evmConnect, "function pick(", "{ connector },")],
  ];
  for (const [name, body] of cases) {
    it(name, () => {
      const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(code).not.toMatch(/\bawait\b/);
    });
  }
});
