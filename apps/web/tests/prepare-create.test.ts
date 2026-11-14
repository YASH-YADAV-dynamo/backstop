import { vaultCreateDeposit } from "@backstop/config/vault-plan";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestView } from "@/lib/vault-requests";

const OWNER = "alice.near";
const ADDRESS = "0x1111111111111111111111111111111111111111";
const DEPLOYER_PK = "ed25519:DcA2MzgpJbrUATQLLceocVckhhAqrkingax4oJ9kZ847";
const CODE_BYTES = 277_247;
const DEPOSIT = vaultCreateDeposit(CODE_BYTES);

let debtKind: "usdc" | "none" | "other";
let ownerBalance: bigint;
let existing: RequestView[];
let nameTaken: boolean;
let invite: { allowed: boolean; inviteOnly: boolean };
let inviteFails: boolean;
const env = { vaultDeployerPk: DEPLOYER_PK as string | undefined, policyCodeBytes: CODE_BYTES, policyCodeHash: "ab".repeat(32), agentId: "bot.backstop.near" };

vi.mock("@/lib/public-env", () => ({ PUBLIC_ENV: env }));
vi.mock("@/lib/vault-requests", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/vault-requests")>()),
  fetchOwnerRequests: vi.fn(async () => existing),
  fetchInviteStatus: vi.fn(async () => {
    if (inviteFails) throw new Error("network down");
    return invite;
  }),
}));
vi.mock("@/lib/loan-client", () => ({
  readDebt: vi.fn(async () => ({ kind: debtKind, healthFactor: null, debtBase: 1n, collateralBase: 1n })),
  readEthBalance: vi.fn(),
  readLoan: vi.fn(),
}));
vi.mock("@/lib/near-rpc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/near-rpc")>()),
  viewAccount: vi.fn(async (id: string) => (id === OWNER ? { amount: ownerBalance, codeHash: "x", storageUsage: 1 } : nameTaken ? { amount: 1n, codeHash: "x", storageUsage: 1 } : null)),
}));

const { prepareCreateVault } = await import("@/lib/review");
const input = { chainKey: "base", loanAddress: ADDRESS, fields: { triggerHf: "1.10", maxPerRescue: "5", dailyCap: "10" }, salt: "00112233445566778899aabbccddeeff" };

const request = (i: number, status: RequestView["status"]): RequestView => ({
  vaultId: `bkst-${String(i).padStart(20, "0")}.near`,
  owner: OWNER,
  chainKey: "base",
  status,
  lastError: null,
  createdAt: "2026-11-14T12:00:00.000Z",
  updatedAt: "2026-11-14T12:00:00.000Z",
});

beforeEach(() => {
  debtKind = "usdc";
  ownerBalance = 10n * 10n ** 24n;
  existing = [];
  nameTaken = false;
  invite = { allowed: true, inviteOnly: true };
  inviteFails = false;
  env.vaultDeployerPk = DEPLOYER_PK;
});

describe("prepareCreateVault", () => {
  it("refuses_before_the_wallet_when_the_owner_is_not_invited", async () => {
    invite = { allowed: false, inviteOnly: true };
    const r = await prepareCreateVault(OWNER, input);
    expect(r).toEqual({ ok: false, reason: "Vault creation is invite-only right now. Ask the Backstop team to add alice.near to the invite list." });
  });
  it("fails_closed_when_the_invite_check_itself_fails", async () => {
    inviteFails = true;
    expect(await prepareCreateVault(OWNER, input)).toEqual({ ok: false, reason: "Could not check your invite; try again." });
  });
  it("an_open_site_does_not_block", async () => {
    invite = { allowed: true, inviteOnly: false };
    expect((await prepareCreateVault(OWNER, input)).ok).toBe(true);
  });
  it("sends_one_near_create_account_with_the_setup_key_and_the_exact_deposit", async () => {
    const r = await prepareCreateVault(OWNER, input);
    if (!r.ok || r.network !== "near") throw new Error(r.ok ? "expected a NEAR review" : r.reason);
    expect(r.txs).toHaveLength(1);
    const tx = r.txs[0]!;
    expect(tx.receiverId).toBe("near");
    expect(tx.calls).toHaveLength(1);
    const call = tx.calls[0]!;
    expect(call.methodName).toBe("create_account");
    expect(call.depositYocto).toBe(DEPOSIT.toString());
    expect(call.gasTgas).toBeGreaterThanOrEqual(50);
    expect(call.args).toEqual({ new_account_id: expect.stringMatching(/^bkst-[0-9a-f]{20}\.near$/), new_public_key: DEPLOYER_PK });
    expect(r.sentence).toBe("Create your Rescue vault on Base.");
    expect(r.rows.map(([l]) => l)).toEqual(
      expect.arrayContaining(["Loan chain", "Loan address on Base", "Rescue at health", "Most per rescue", "Most per day", "Rescue bot", "Service fee", "Vault owner", "Refundable deposit"]),
    );
    expect(r.rows.find(([l]) => l === "Refundable deposit")![1]).toContain("returned to you when you close the vault");
    expect(r.notes[0]).toBe("Refundable deposit: 2.944 NEAR. This keeps your vault on NEAR. You get it back when you close your vault.");
  });
  it("the_same_salt_keeps_the_same_vault_name_across_re_prepares", async () => {
    const a = await prepareCreateVault(OWNER, input);
    const b = await prepareCreateVault(OWNER, input);
    if (!a.ok || !b.ok || a.network !== "near" || b.network !== "near") throw new Error("expected NEAR reviews");
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.txs[0]!.calls[0]!.args).toEqual(b.txs[0]!.calls[0]!.args);
  });
  it("refuses_a_name_that_is_already_taken", async () => {
    nameTaken = true;
    const r = await prepareCreateVault(OWNER, input);
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/already taken/) });
  });
  it("is_off_until_the_setup_key_is_configured", async () => {
    env.vaultDeployerPk = undefined;
    expect(await prepareCreateVault(OWNER, input)).toEqual({ ok: false, reason: "Vault creation opens soon." });
  });
  it("loan_without_usdc_debt_cannot_be_protected", async () => {
    debtKind = "none";
    expect(await prepareCreateVault(OWNER, input)).toEqual({ ok: false, reason: "We found no Aave loan at this address on Base." });
    debtKind = "other";
    expect(await prepareCreateVault(OWNER, input)).toEqual({ ok: false, reason: "This loan's debt isn't USDC. Backstop can only repay USDC debt for now." });
  });
  it("refuses when the account cannot cover the deposit and says it is returned", async () => {
    ownerBalance = 2n * 10n ** 24n;
    const r = await prepareCreateVault(OWNER, input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("You get it back when you close the vault.");
  });
  it("a short-of-NEAR refusal carries what is needed and what the account has (for the Ethereum-wallet hint)", async () => {
    ownerBalance = 2n * 10n ** 24n;
    const r = await prepareCreateVault(OWNER, input);
    if (r.ok) throw new Error("expected a refusal");
    expect(r.nearShort?.haveYocto).toBe(ownerBalance);
    expect(r.nearShort!.needYocto).toBeGreaterThan(DEPOSIT);
  });
  it("refuses the ninth vault but does not count failed or refunded ones", async () => {
    existing = Array.from({ length: 8 }, (_, i) => request(i, i % 2 ? "ready" : "pending"));
    expect(await prepareCreateVault(OWNER, input)).toEqual({ ok: false, reason: "You've reached the limit of 8 vaults. Close one to open another." });
    existing = Array.from({ length: 8 }, (_, i) => request(i, i % 2 ? "failed" : "aborted"));
    expect((await prepareCreateVault(OWNER, input)).ok).toBe(true);
  });
});
