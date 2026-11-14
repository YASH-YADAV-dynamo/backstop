import { describe, expect, it } from "vitest";
import { classifyWalletError, errorText, isRequestPending, isUserRejection, parseOutcome, walletErrorMessage } from "@/lib/wallet-errors";

const HASH = "6mGxN1nBX3rBk8V8Q5mPf3RSCcWZtD8fXqZxWQ3qeCnP";

describe("an already-open wallet request is its own kind, never a rejection", () => {
  const cases: Array<[string, unknown]> = [
    ["Rabby through NEAR Connect", new Error("Connection declined — Connection can be declined if a previous request is still active")],
    ["MetaMask -32002", { code: -32002, message: "Request of type 'wallet_requestPermissions' already pending for origin. Please wait." }],
    ["WalletConnect", new Error("Request already pending")],
    ["nested in viem's cause", { name: "ResourceUnavailableRpcError", message: "Resource unavailable", cause: { code: -32002, message: "x" } }],
    ["viem details", { shortMessage: "Requested resource not available.", details: "A previous request is still pending" }],
    ["code 4001 but the text says an earlier request is open", { code: 4001, message: "Previous request is still active" }],
  ];
  for (const [name, err] of cases) {
    it(name, () => {
      expect(isRequestPending(err)).toBe(true);
      expect(isUserRejection(err)).toBe(false);
      expect(classifyWalletError(err)).toBe("pending");
    });
  }

  it("a plain no is still a rejection", () => {
    expect(classifyWalletError({ code: 4001, message: "User rejected the request." })).toBe("rejected");
    expect(classifyWalletError(new Error("User rejected"))).toBe("rejected");
  });

  it("the open-request message says where to go and what to press, in plain words", () => {
    const { kind, message } = walletErrorMessage({ code: -32002, message: "already pending" }, "Could not connect");
    expect(kind).toBe("pending");
    expect(message).toMatch(/open your wallet/i);
    expect(message).toMatch(/finish or reject/i);
    expect(message).toMatch(/Try again/);
    expect(message).not.toMatch(/EIP|-32002|1193/);
  });

  it("every other kind also ends with what to do next", () => {
    for (const err of [new Error("User rejected"), new Error("Popup blocked by the browser"), { code: 4902, message: "Unrecognized chain" }, new Error("boom")]) {
      expect(walletErrorMessage(err, "Could not connect").message).toMatch(/press Try again/i);
    }
    expect(walletErrorMessage(new Error("boom"), "Could not connect", "the switch button again").message).toContain("Press the switch button again");
  });
});

describe("errorText never throws", () => {
  it("handles empty, odd and hostile errors", () => {
    expect(errorText(undefined)).toBe("Unknown error");
    expect(errorText(new Error(""))).toBe("Unknown error");
    expect(errorText("plain string")).toBe("plain string");
    const hostile = Object.defineProperty({}, "message", {
      get() {
        throw new Error("no");
      },
    });
    expect(errorText(hostile)).toBe("Unknown error");
  });
});

describe("parseOutcome never throws on what a wallet returns", () => {
  it("a full outcome gives the hash and no failure", () => {
    expect(parseOutcome({ status: { SuccessValue: "" }, transaction: { hash: HASH }, receipts_outcome: [] })).toEqual({ hash: HASH, failure: null });
  });
  it("nothing at all (redirect wallets)", () => {
    for (const raw of [undefined, null, "", 0, true, [], {}]) expect(parseOutcome(raw)).toEqual({ hash: null, failure: null });
  });
  it("only a hash string", () => {
    expect(parseOutcome(HASH)).toEqual({ hash: HASH, failure: null });
    expect(parseOutcome("not a hash")).toEqual({ hash: null, failure: null });
  });
  it("a hash under another key, or in transaction_outcome", () => {
    expect(parseOutcome({ transactionHash: HASH }).hash).toBe(HASH);
    expect(parseOutcome({ hash: HASH }).hash).toBe(HASH);
    expect(parseOutcome({ transaction_outcome: { id: HASH } }).hash).toBe(HASH);
  });
  it("one malformed field does not hide the others", () => {
    expect(parseOutcome({ transaction: { hash: 42 }, transaction_outcome: { id: HASH }, receipts_outcome: "nope" })).toEqual({ hash: HASH, failure: null });
    expect(parseOutcome({ transaction: { hash: HASH }, receipts_outcome: [null, 5, { outcome: { status: { Failure: { msg: "Smart contract panicked: ERR_X" } } } }] })).toEqual({
      hash: HASH,
      failure: "ERR_X",
    });
  });
  it("a failure that cannot be turned into text is still a failure", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const r = parseOutcome({ transaction: { hash: HASH }, status: { Failure: circular } });
    expect(r.hash).toBe(HASH);
    expect(r.failure).toMatch(/failed/);
  });
  it("a getter that throws is read as nothing", () => {
    const hostile = Object.defineProperty({}, "transaction", {
      enumerable: true,
      get() {
        throw new Error("no");
      },
    });
    expect(parseOutcome(hostile)).toEqual({ hash: null, failure: null });
  });
});
