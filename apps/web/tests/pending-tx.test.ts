import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearJournal, loadJournal, receiptChainFor, setJournalHash, startJournal, type JournalEntry } from "@/lib/pending-tx";
import { arbitrumChain } from "./fixtures/policy";

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
}

const account = "0xabc0000000000000000000000000000000000001";

beforeEach(() => {
  vi.stubGlobal("window", { sessionStorage: memoryStorage(), localStorage: memoryStorage() });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const evm = (extra: Partial<JournalEntry>): JournalEntry => ({ id: "1", kind: "gas", chain: "evm", account, contractId: "0xto", method: "eth_sendTransaction", args: {}, createdAt: 0, hash: "0xhash", ...extra });

describe("the pending-transaction journal knows which chain a transaction was sent on", () => {
  it("an EVM journal entry keeps its chain id", () => {
    const entry = startJournal({ kind: "gas", chain: "evm", account, contractId: "0xto", method: "eth_sendTransaction", args: {}, evmChainId: arbitrumChain.chainId });
    setJournalHash(entry, "0xhash");
    const loaded = loadJournal(account).entry;
    expect(loaded?.evmChainId).toBe(arbitrumChain.chainId);
    expect(loaded?.hash).toBe("0xhash");
    clearJournal(account);
    expect(loadJournal(account).entry).toBeNull();
  });
  it("an entry without a chain id is not polled", () => {
    expect(receiptChainFor(evm({}))).toBeNull();
  });
  it("an entry on a chain Backstop does not run is not polled", () => {
    expect(receiptChainFor(evm({ evmChainId: 1 }))).toBeNull();
  });
  it("an entry on a loan chain is polled on exactly that chain", () => {
    expect(receiptChainFor(evm({ evmChainId: arbitrumChain.chainId }))).toBe(arbitrumChain);
  });
  it("a NEAR entry never selects an EVM chain", () => {
    expect(receiptChainFor(evm({ chain: "near", evmChainId: arbitrumChain.chainId }))).toBeNull();
  });
});
