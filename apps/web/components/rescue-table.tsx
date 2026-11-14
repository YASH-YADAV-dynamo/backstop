import { ExternalLink } from "lucide-react";
import { ChainBadge } from "@/components/chain-badge";
import { ErrorNote, EmptyNote } from "@/components/section-state";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ChainView, RescueRow, Section } from "@/lib/dashboard-types";

const STATUS: Record<RescueRow["status"], { label: string; variant: "safe" | "danger" | "outline" }> = {
  success: { label: "Success", variant: "safe" },
  failed: { label: "Failed", variant: "danger" },
  "dry-run": { label: "Dry run", variant: "outline" },
};

function TxLink({ href, label }: { href: string | undefined; label: string }) {
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 whitespace-nowrap text-primary hover:underline"
    >
      {label}
      <ExternalLink className="size-3" aria-hidden />
    </a>
  );
}

/**
 * Rescue history, newest first (landing page and dashboard). Mainnet rescues are listed first;
 * dry runs are shown separately and clearly labelled, since they moved no funds.
 */
export function RescueHistory({ history, chain }: { history: Section<RescueRow[]>; chain: ChainView | null }) {
  if (history.state === "error") return <ErrorNote message="We couldn't load the rescue history right now." details={history.message} />;
  if (history.state === "unconfigured") return <EmptyNote>{history.message}</EmptyNote>;
  const mainnet = history.data.filter((r) => !r.dryRun);
  const dryRuns = history.data.filter((r) => r.dryRun);
  return (
    <div className="flex flex-col gap-4">
      {mainnet.length === 0 ? <EmptyNote>No rescues yet.</EmptyNote> : <RescueRows rows={mainnet} chain={chain} />}
      {dryRuns.length > 0 && (
        <RescueRows rows={dryRuns} chain={chain} caption={`Dry runs (${dryRuns.length}): simulated, no funds moved, no transactions sent`} />
      )}
    </div>
  );
}

function RescueRows({ rows, chain, caption }: { rows: RescueRow[]; chain: ChainView | null; caption?: string }) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      {caption && <p className="border-b px-3 py-2 text-xs text-muted-foreground">{caption}</p>}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Health</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Details</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => {
            const status = STATUS[r.status];
            return (
              <TableRow key={r.id}>
                <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">{r.date}</TableCell>
                <TableCell className="whitespace-nowrap tabular-nums">
                  {r.hfBefore} <span className="text-muted-foreground">→</span> {r.hfAfter ?? "—"}
                </TableCell>
                <TableCell className="whitespace-nowrap text-right tabular-nums">{r.amountUsdc} USDC</TableCell>
                <TableCell>
                  <Badge variant={status.variant}>{status.label}</Badge>
                </TableCell>
                <TableCell className="min-w-56">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                    {chain ? <ChainBadge chain={chain} /> : null}
                    <TxLink href={r.links.oneClickStatus} label="Deposit status" />
                    <TxLink href={r.links.nearRescueTx} label="NEAR rescue tx" />
                    <TxLink href={r.links.baseRepayTx} label={chain ? `Repay tx (${chain.name})` : "Repay tx"} />
                  </div>
                  {r.error && <p className="mt-2 max-w-md break-words text-xs text-danger">{r.error}</p>}
                  {r.receipt && (
                    <details className="mt-2 max-w-md text-xs">
                      <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
                        Receipt <span className="ml-1 rounded bg-muted px-1.5 py-0.5">source: {r.receipt.source}</span>
                      </summary>
                      <p className="mt-2 leading-relaxed">{r.receipt.text}</p>
                    </details>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
