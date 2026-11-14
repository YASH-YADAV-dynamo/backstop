import { describe, expect, it } from "vitest";
import type { Provider } from "near-api-js";
import { FailoverRpcError } from "near-api-js";
import { loanChainByKey } from "@backstop/config";
import type { PublicClient } from "viem";
import { evmClient, l1DataFee, nearProvider, rpcErrorMessage, viewAccessKeys } from "../src/index.js";

const fakeProvider = (keys: unknown[], lastKey: string | null = null) =>
  ({ viewAccessKeyList: async () => ({ keys, last_key: lastKey, block_hash: "h", block_height: 1 }) }) as unknown as Provider;

describe("viewAccessKeys", () => {
  it("reports an empty list for a keyless account", async () => {
    expect(await viewAccessKeys(fakeProvider([]), "policy.near")).toEqual([]);
  });

  it("flags full-access keys", async () => {
    const keys = [
      { public_key: "ed25519:aaa", access_key: { nonce: 1, permission: "FullAccess" } },
      { public_key: "ed25519:bbb", access_key: { nonce: 1, permission: { FunctionCall: { method_names: [], receiver_id: "x" } } } },
    ];
    expect(await viewAccessKeys(fakeProvider(keys), "policy.near")).toEqual([
      { publicKey: "ed25519:aaa", fullAccess: true },
      { publicKey: "ed25519:bbb", fullAccess: false },
    ]);
  });

  it("refuses a truncated listing instead of calling the account keyless", async () => {
    await expect(viewAccessKeys(fakeProvider([], "next"), "policy.near")).rejects.toThrow(/more access keys/);
  });
});

describe("rpc lists", () => {
  it("rejects an empty URL list", () => {
    expect(() => nearProvider([])).toThrow(/No NEAR RPC URL/);
    expect(() => evmClient(loanChainByKey("base"), [])).toThrow(/No Base RPC URL/);
    expect(() => evmClient(loanChainByKey("arbitrum"), [])).toThrow(/No Arbitrum One RPC URL.*ARBITRUM_RPC_URL/);
  });

  it("unwraps the first underlying error of a failover", () => {
    expect(rpcErrorMessage(new FailoverRpcError(2, [new Error("first"), new Error("second")]))).toBe("first");
    expect(rpcErrorMessage(new Error("plain"))).toBe("plain");
  });
});

describe("nearProvider failover", () => {
  const ok = { viewAccessKeyList: async () => ({ keys: [], last_key: null, block_hash: "h", block_height: 1 }) };
  const down = {
    viewAccessKeyList: async () => {
      throw new Error("fetch failed\n    at stack line");
    },
  };

  it("fails over to the next URL and reports one line per failed attempt, no stack", async () => {
    const lines: string[] = [];
    const p = nearProvider(["https://a.example", "https://b.example"], (url, err) => lines.push(`${url}: ${(err as Error).message.split("\n")[0]}`));
    (p as unknown as { providers: unknown[] }).providers.splice(0, 2, down, ok);
    expect(await viewAccessKeys(p, "policy.near")).toEqual([]);
    expect(lines).toEqual(["https://a.example: fetch failed"]);
  });

  it("throws a FailoverRpcError with every underlying error when all URLs fail", async () => {
    const lines: string[] = [];
    const p = nearProvider(["https://a.example", "https://b.example"], (url) => lines.push(url));
    (p as unknown as { providers: unknown[] }).providers.splice(0, 2, down, down);
    const err = await p.viewAccessKeyList({ accountId: "policy.near", finalityQuery: { finality: "final" } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FailoverRpcError);
    expect(rpcErrorMessage(err)).toMatch(/^fetch failed/);
    expect(lines).toEqual(["https://a.example"]);
  });

  it("does not fail over on a definitive answer: the real message comes back at once", async () => {
    const lines: string[] = [];
    let second = 0;
    const missing = {
      viewAccount: async () => {
        throw new Error("Account nobody.near does not exist while viewing");
      },
    };
    const counting = {
      viewAccount: async () => {
        second++;
        return {};
      },
    };
    const p = nearProvider(["https://a.example", "https://b.example"], (url) => lines.push(url));
    (p as unknown as { providers: unknown[] }).providers.splice(0, 2, missing, counting);
    const err = await p.viewAccount({ accountId: "nobody.near" }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/does not exist/);
    expect(second).toBe(0);
    expect(lines).toEqual([]);
  });
});

describe("l1DataFee", () => {
  const tx = { from: "0x000000000000000000000000000000000000bEEF", to: "0x000000000000000000000000000000000000dEaD", value: 0n, data: "0x" } as const;

  it("is 0 on Arbitrum without any RPC call (the L1 component is already in its gas estimate)", async () => {
    const calls: string[] = [];
    const client = new Proxy({}, { get: (_t, prop) => { calls.push(String(prop)); throw new Error("no RPC expected"); } }) as unknown as PublicClient;
    expect(await l1DataFee(client, loanChainByKey("arbitrum"), tx)).toBe(0n);
    expect(calls).toEqual([]);
  });

  it("asks the GasPriceOracle on Base (OP-stack)", async () => {
    const client = { call: async () => { throw new Error("oracle asked"); }, request: async () => { throw new Error("oracle asked"); } } as unknown as PublicClient;
    await expect(l1DataFee(client, loanChainByKey("base"), tx)).rejects.toThrow();
  });
});
