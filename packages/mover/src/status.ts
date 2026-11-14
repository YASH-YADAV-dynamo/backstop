import { baseUrlOf, requestJson, type OneClickOptions } from "./http.js";
import { statusResponseSchema, type ExecutionStatus, type StatusResponse, type TxDetails } from "./schemas.js";

export const TERMINAL_STATUSES = ["SUCCESS", "REFUNDED", "FAILED", "INCOMPLETE_DEPOSIT"] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

const isTerminal = (s: ExecutionStatus): s is TerminalStatus => (TERMINAL_STATUSES as readonly string[]).includes(s);

export interface StatusUpdate {
  status: ExecutionStatus;
  updatedAt: string;
  depositAddress: string;
  /** Public GET /v0/status URL for this deposit (for records and dashboards). */
  statusUrl: string;
  nearTxHashes: string[];
  originTxs: TxDetails[];
  /** Base transactions that delivered USDC, with explorer URLs. */
  destinationTxs: TxDetails[];
  amountIn?: bigint;
  amountOut?: bigint;
  refundedAmount?: bigint;
  refundReason?: string;
}

export interface FinalStatus extends StatusUpdate {
  status: TerminalStatus;
}

export const statusUrl = (depositAddress: string, opts: OneClickOptions = {}): string =>
  `${baseUrlOf(opts)}/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`;

function toUpdate(res: StatusResponse, depositAddress: string, opts: OneClickOptions): StatusUpdate {
  const d = res.swapDetails;
  return {
    status: res.status,
    updatedAt: res.updatedAt,
    depositAddress,
    statusUrl: statusUrl(depositAddress, opts),
    nearTxHashes: d.nearTxHashes,
    originTxs: d.originChainTxHashes,
    destinationTxs: d.destinationChainTxHashes,
    ...(d.amountIn !== undefined && { amountIn: d.amountIn }),
    ...(d.amountOut !== undefined && { amountOut: d.amountOut }),
    ...(d.refundedAmount !== undefined && { refundedAmount: d.refundedAmount }),
    ...(d.refundReason !== undefined && { refundReason: d.refundReason }),
  };
}

export interface SubmitDepositParams {
  /** NEAR tx hash of the ft_transfer to depositAddress. */
  txHash: string;
  depositAddress: string;
  /** NEAR account that sent the deposit. */
  nearSenderAccount: string;
}

/** POST /v0/deposit/submit: tells 1Click about our deposit so it starts without waiting to detect it. */
export async function submitDeposit(params: SubmitDepositParams, opts: OneClickOptions = {}): Promise<StatusUpdate> {
  const res = await requestJson(
    "/v0/deposit/submit",
    statusResponseSchema,
    {
      method: "POST",
      body: { txHash: params.txHash, depositAddress: params.depositAddress, nearSenderAccount: params.nearSenderAccount },
    },
    opts,
  );
  return toUpdate(res, params.depositAddress, opts);
}

/** GET /v0/status once. */
export async function getStatus(depositAddress: string, opts: OneClickOptions = {}): Promise<StatusUpdate> {
  const res = await requestJson(
    `/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`,
    statusResponseSchema,
    { method: "GET" },
    opts,
  );
  return toUpdate(res, depositAddress, opts);
}

export interface PollOptions {
  /** Default 5s. */
  intervalMs?: number;
  /** Default 15 minutes. */
  timeoutMs?: number;
  /** Called whenever the status changes (and once for the first reading). */
  onUpdate?: (u: StatusUpdate) => void;
}

/**
 * Poll GET /v0/status until SUCCESS, REFUNDED, FAILED or INCOMPLETE_DEPOSIT.
 * Rejects after `timeoutMs` with the last status seen; the swap may still finish, so check `statusUrl`.
 */
export async function pollStatus(
  depositAddress: string,
  poll: PollOptions = {},
  opts: OneClickOptions = {},
): Promise<FinalStatus> {
  const intervalMs = poll.intervalMs ?? 5_000;
  const timeoutMs = poll.timeoutMs ?? 15 * 60_000;
  const deadline = Date.now() + timeoutMs;
  let last: ExecutionStatus | undefined;
  for (;;) {
    const u = await getStatus(depositAddress, opts);
    if (u.status !== last) {
      last = u.status;
      poll.onUpdate?.(u);
    }
    if (isTerminal(u.status)) return { ...u, status: u.status };
    if (Date.now() + intervalMs > deadline) {
      throw new Error(
        `1Click swap for ${depositAddress} still ${u.status} after ${Math.round(timeoutMs / 1000)}s. ` +
          `It may still complete: check ${u.statusUrl} before retrying, or funds could move twice.`,
      );
    }
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
}
