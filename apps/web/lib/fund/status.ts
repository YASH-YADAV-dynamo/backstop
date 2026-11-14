/** GET /api/fund/status logic: validate the address, 5 s cache, proxy mover.getStatus. Server only. */
import { getStatus, type StatusUpdate } from "@backstop/mover";
import { redactUrls } from "@/lib/redact";
import { statusOptions } from "@/lib/fund/server-deps";

export const DEPOSIT_ADDRESS_RE = /^[A-Za-z0-9._:\-]{8,128}$/;

export type StatusView = {
  status: StatusUpdate["status"];
  updatedAt: string;
  nearTxHashes: string[];
  destinationTxs: Array<{ hash: string; explorerUrl: string }>;
  originTxs: Array<{ hash: string; explorerUrl: string }>;
  amountIn?: string;
  amountOut?: string;
  refundedAmount?: string;
  refundReason?: string;
};

const TTL_MS = 5_000;
const MAX = 200;
const cache = new Map<string, { at: number; pending: Promise<StatusView> }>();

function toView(u: StatusUpdate): StatusView {
  return {
    status: u.status,
    updatedAt: u.updatedAt,
    nearTxHashes: u.nearTxHashes,
    destinationTxs: u.destinationTxs.map((t) => ({ hash: t.hash, explorerUrl: t.explorerUrl })),
    originTxs: u.originTxs.map((t) => ({ hash: t.hash, explorerUrl: t.explorerUrl })),
    ...(u.amountIn !== undefined && { amountIn: u.amountIn.toString() }),
    ...(u.amountOut !== undefined && { amountOut: u.amountOut.toString() }),
    ...(u.refundedAmount !== undefined && { refundedAmount: u.refundedAmount.toString() }),
    ...(u.refundReason !== undefined && { refundReason: u.refundReason }),
  };
}

export function cachedStatus(depositAddress: string): Promise<StatusView> {
  const hit = cache.get(depositAddress);
  const now = Date.now();
  if (hit && now - hit.at < TTL_MS) return hit.pending;
  cache.delete(depositAddress);
  while (cache.size >= MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  const pending = getStatus(depositAddress, statusOptions()).then(toView);
  cache.set(depositAddress, { at: now, pending });
  pending.catch(() => cache.delete(depositAddress));
  return pending;
}

export const statusError = (err: unknown) => redactUrls(err instanceof Error ? err.message.split("\n")[0]! : String(err));
