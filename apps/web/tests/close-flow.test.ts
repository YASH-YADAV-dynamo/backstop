import { describe, expect, it } from "vitest";
import { CLOSE_MAX_USDC_DUST, CLOSE_QUIET_SECS, closeFlow, lastRequestAt, waitSecsLeft, type CloseInput } from "@/lib/close-flow";

const NOW = 1_800_000_000;
const base: CloseInput = { paused: false, usdcBalance: 20_000_000n, lastRequestAt: 0, lastBridgeAt: 0, nowSecs: NOW };

describe("closeFlow mirrors the contract's close rules", () => {
  it("starts with pausing, because close needs a paused vault", () => {
    const f = closeFlow(base);
    expect(f.current).toBe("pause");
    expect(f.ready).toBe(false);
    expect(f.steps.map((s) => s.state)).toEqual(["current", "todo", "todo", "todo"]);
  });
  it("after pausing asks to withdraw all USDC", () => {
    expect(closeFlow({ ...base, paused: true }).current).toBe("withdraw");
  });
  it("treats a dust balance under 0.01 USDC as already withdrawn", () => {
    expect(closeFlow({ ...base, paused: true, usdcBalance: CLOSE_MAX_USDC_DUST }).current).toBe("close");
    expect(closeFlow({ ...base, paused: true, usdcBalance: CLOSE_MAX_USDC_DUST + 1n }).current).toBe("withdraw");
  });
  it("waits out the one-hour window after the last request and counts down, never errors", () => {
    const f = closeFlow({ ...base, paused: true, usdcBalance: 0n, lastRequestAt: NOW - 600 });
    expect(f.current).toBe("wait");
    expect(f.waitSecs).toBe(CLOSE_QUIET_SECS - 600);
    expect(f.ready).toBe(false);
    expect(f.steps[2]!.detail).not.toMatch(/error|fail/i);
  });
  it("opens the close step exactly when the window has passed", () => {
    const at = { ...base, paused: true, usdcBalance: 0n, lastRequestAt: NOW - CLOSE_QUIET_SECS };
    const f = closeFlow(at);
    expect(f.current).toBe("close");
    expect(f.ready).toBe(true);
    expect(closeFlow({ ...at, nowSecs: NOW - 1 }).ready).toBe(false);
  });
  it("a vault that never ran anything has no window to wait for", () => {
    expect(waitSecsLeft(0, NOW)).toBe(0);
    expect(closeFlow({ ...base, paused: true, usdcBalance: 0n }).ready).toBe(true);
  });
  it("explains a bridge in flight as money on its way", () => {
    const f = closeFlow({ ...base, paused: true, usdcBalance: 0n, lastRequestAt: NOW - 120, lastBridgeAt: NOW - 120 });
    expect(f.bridgeInFlight).toBe(true);
    expect(f.steps[2]!.detail).toBe("Money is on its way. Try again in a few minutes.");
  });
  it("a rescue (not a bridge) in the window is a plain wait", () => {
    const f = closeFlow({ ...base, paused: true, usdcBalance: 0n, lastRequestAt: NOW - 120, lastBridgeAt: 0 });
    expect(f.bridgeInFlight).toBe(false);
  });
  it("does not count the window as passed before the vault is paused", () => {
    expect(closeFlow({ ...base, paused: false, usdcBalance: 0n }).steps.find((s) => s.id === "wait")!.state).not.toBe("done");
  });
  it("goes back to withdraw if a refund brings USDC back into a paused, waited vault", () => {
    expect(closeFlow({ ...base, paused: true, usdcBalance: 3_000_000n, lastRequestAt: 1 }).current).toBe("withdraw");
  });
});

describe("lastRequestAt", () => {
  it("is the latest of rescue, bridge and approval, like the contract's last_request_at", () => {
    expect(lastRequestAt({ last_rescue_at: 5n, last_bridge_at: 9n, last_approve_at: 7n })).toBe(9);
  });
});
