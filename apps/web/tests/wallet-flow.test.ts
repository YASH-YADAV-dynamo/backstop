import { describe, expect, it } from "vitest";
import { createInFlightGuard, ethereumWalletNearHint, evmWalletChoices, interpretNearError, interpretNearOutcomes, isEthereumNearAccount, PENDING_MAX_FAILURES, pendingGivesUp, wrongNetworkMessage } from "@/lib/wallet-flow";

const H1 = "6mGxN1nBX3rBk8V8Q5mPf3RSCcWZtD8fXqZxWQ3qeCnP";
const H2 = "9QqUfpGtVVkGGdXJyWbGd2rpE1rHMhpM3yDYoU8gRXWv";
const NEAR = 10n ** 24n;

describe("one wallet request at a time", () => {
  it("a second click while one is open gets no slot", () => {
    const g = createInFlightGuard();
    const t = g.begin();
    expect(t).not.toBeNull();
    expect(g.begin()).toBeNull();
    expect(g.busy()).toBe(true);
    expect(g.end(t!)).toBe(true);
    expect(g.busy()).toBe(false);
    expect(g.begin()).not.toBeNull();
  });
  it("reset frees the slot and makes the old request's late answer stale", () => {
    const g = createInFlightGuard();
    const old = g.begin()!;
    g.reset();
    const fresh = g.begin()!;
    expect(fresh).not.toBe(old);
    expect(g.holds(old)).toBe(false);
    expect(g.end(old)).toBe(false); // the late answer does not free the new request's slot
    expect(g.holds(fresh)).toBe(true);
    expect(g.end(fresh)).toBe(true);
  });
});

describe("what a NEAR wallet's answer means for the screen and the pending journal", () => {
  it("one hash per transaction is a success and clears the journal", () => {
    expect(interpretNearOutcomes([{ transaction: { hash: H1 } }, { transaction: { hash: H2 } }], 2)).toEqual({ result: { status: "success", hashes: [H1, H2] }, hash: H1, clearJournal: true });
  });
  it("only a bare hash string is a success", () => {
    expect(interpretNearOutcomes(H1, 1)).toMatchObject({ result: { status: "success", hashes: [H1] }, clearJournal: true });
  });
  it("nothing returned stays unknown and keeps the journal", () => {
    for (const raw of [undefined, null, [], {}, "ok", [null], 42]) {
      const a = interpretNearOutcomes(raw, 1);
      expect(a.result.status).toBe("unknown");
      expect(a.clearJournal).toBe(false);
    }
  });
  it("fewer hashes than transactions stays unknown, keeps the journal and records the hash it has", () => {
    const a = interpretNearOutcomes([{ transaction: { hash: H1 } }, {}], 2);
    expect(a.result.status).toBe("unknown");
    expect(a.hash).toBe(H1);
    expect(a.clearJournal).toBe(false);
  });
  it("a contract failure is final", () => {
    const a = interpretNearOutcomes({ transaction: { hash: H1 }, status: { Failure: { x: "Smart contract panicked: ERR_NOT_OWNER" } } }, 1);
    expect(a.result.status).toBe("failed");
    expect(a.clearJournal).toBe(true);
  });
  it("an open request in the wallet: nothing was sent, try again later", () => {
    const a = interpretNearError(new Error("Connection declined — Connection can be declined if a previous request is still active"));
    expect(a.result.status).toBe("pending");
    if (a.result.status === "pending") expect(a.result.message).toMatch(/Try again/);
    expect(a.clearJournal).toBe(true);
  });
  it("a no clears the journal; a blocked popup is a final failure", () => {
    expect(interpretNearError(new Error("User rejected"))).toMatchObject({ result: { status: "rejected" }, clearJournal: true });
    expect(interpretNearError(new Error("Popup was blocked"))).toMatchObject({ result: { status: "failed" }, clearJournal: true });
  });
  it("any other error may have happened after sending: unknown, journal kept, says to check history", () => {
    const a = interpretNearError(new Error("Failed to fetch"));
    expect(a.result.status).toBe("unknown");
    if (a.result.status === "unknown") expect(a.result.message).toMatch(/check your wallet's history/);
    expect(a.clearJournal).toBe(false);
  });
  it("odd errors never throw", () => {
    for (const e of [undefined, null, 0, {}, [], Symbol("x")]) expect(() => interpretNearError(e)).not.toThrow();
  });
});

describe("EVM wallet choices prefer the wallet the user picked", () => {
  const rabby = { id: "io.rabby", type: "injected", name: "Rabby" };
  const metamask = { id: "io.metamask", type: "injected", name: "MetaMask" };
  const generic = { id: "injected", type: "injected", name: "Injected" };
  const wc = { id: "walletConnect", type: "walletConnect", name: "WalletConnect" };
  it("with announced wallets, the bare window.ethereum entry is hidden", () => {
    expect(evmWalletChoices([generic, rabby, metamask, wc], true).map((c) => c.id)).toEqual(["io.rabby", "io.metamask", "walletConnect"]);
  });
  it("the bare entry is offered only when no wallet announced itself and one exists", () => {
    expect(evmWalletChoices([generic, wc], true).map((c) => c.id)).toEqual(["injected", "walletConnect"]);
    expect(evmWalletChoices([generic, wc], false).map((c) => c.id)).toEqual(["walletConnect"]);
  });
});

describe("NEAR accounts from an Ethereum wallet", () => {
  const eth = "0x1111111111111111111111111111111111111111";
  it("are recognised by wallet name or by account shape", () => {
    expect(isEthereumNearAccount("Ethereum Wallets", "x.near")).toBe(true);
    expect(isEthereumNearAccount("HOT", eth)).toBe(true);
    expect(isEthereumNearAccount("HOT", "alice.near")).toBe(false);
  });
  it("short of NEAR: says how much NEAR, and that ETH or USDC cannot pay it", () => {
    const hint = ethereumWalletNearHint({ walletName: "Ethereum Wallets", accountId: eth, needYocto: 3n * NEAR, haveYocto: NEAR });
    expect(hint).toContain("3 NEAR");
    expect(hint).toContain("at least 2 NEAR");
    expect(hint).toMatch(/ETH or USDC in that wallet cannot pay/);
    expect(hint).toContain(eth);
  });
  it("silent for other wallets, enough NEAR, or an unread balance", () => {
    expect(ethereumWalletNearHint({ walletName: "HOT", accountId: "alice.near", needYocto: 3n * NEAR, haveYocto: 0n })).toBeNull();
    expect(ethereumWalletNearHint({ walletName: "Ethereum Wallets", accountId: eth, needYocto: NEAR, haveYocto: NEAR })).toBeNull();
    expect(ethereumWalletNearHint({ walletName: "Ethereum Wallets", accountId: eth, needYocto: NEAR, haveYocto: null })).toBeNull();
  });
});

describe("wrong network and retry cap", () => {
  it("names both networks and never shows a chain id", () => {
    const text = wrongNetworkMessage("Ethereum", "Base");
    expect(text).toContain("Your wallet is on Ethereum");
    expect(text).toContain("Switch to Base");
    expect(wrongNetworkMessage(null, "Base")).toContain("another network");
    expect(wrongNetworkMessage(null, "Base")).not.toMatch(/\d/);
  });
  it("the create card stops retrying on its own after a fixed number of failures in a row", () => {
    expect(pendingGivesUp(PENDING_MAX_FAILURES - 1)).toBe(false);
    expect(pendingGivesUp(PENDING_MAX_FAILURES)).toBe(true);
  });
});
