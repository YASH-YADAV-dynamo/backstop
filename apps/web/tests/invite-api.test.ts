import type { InviteRequest, InviteRequestStore, NewInviteRequest } from "@backstop/db";
import { describe, expect, it } from "vitest";
import { handleInviteRequest, handleInviteStatus } from "@/lib/invite-api";

function memoryStore(): InviteRequestStore {
  const rows = new Map<string, InviteRequest>();
  return {
    async upsert(req: NewInviteRequest, now: Date) {
      const at = now.toISOString();
      const row = { ...req, createdAt: rows.get(req.account)?.createdAt ?? at, updatedAt: at };
      rows.set(req.account, row);
      return row;
    },
    async get(account) {
      return rows.get(account) ?? null;
    },
  };
}
const deps = (store = memoryStore()) => ({ store: async () => store, now: () => new Date("2026-11-14T18:00:00Z") });

describe("invite requests", () => {
  it("saves a request with only the account (volume and note are optional)", async () => {
    const r = await handleInviteRequest({ account: "Alice.near" }, deps());
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ request: { account: "alice.near", volume: null, requestedAt: "2026-11-14T18:00:00.000Z" } });
  });

  it("asking again updates the same account, and status reads it back", async () => {
    const d = deps();
    await handleInviteRequest({ account: "bob.near" }, d);
    await handleInviteRequest({ account: "bob.near", volume: "1k-10k", note: "  lending on Base  " }, d);
    const s = await handleInviteStatus(new URLSearchParams({ account: "bob.near" }), d);
    expect(s.body).toEqual({ request: { account: "bob.near", volume: "1k-10k", requestedAt: "2026-11-14T18:00:00.000Z" } });
  });

  it("refuses a bad account id, an unknown volume and a long note", async () => {
    expect((await handleInviteRequest({ account: "not a near id" }, deps())).status).toBe(400);
    expect((await handleInviteRequest({ account: "a.near", volume: "a-lot" }, deps())).status).toBe(400);
    expect((await handleInviteRequest({ account: "a.near", note: "x".repeat(501) }, deps())).status).toBe(400);
  });

  it("an account that never asked reads as null", async () => {
    expect((await handleInviteStatus(new URLSearchParams({ account: "carol.near" }), deps())).body).toEqual({ request: null });
  });
});
