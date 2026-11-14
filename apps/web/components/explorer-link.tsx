import { chainAddressUrl, type LoanChain } from "@backstop/config/registry";
import { ExternalLink } from "lucide-react";
import { explorerHost } from "@/lib/chain";

const linkClass = "inline-flex max-w-full flex-wrap items-baseline gap-x-1.5 text-primary hover:underline";

/** An address on the loan chain's explorer (from the registry). The explorer host is shown so the chain is unmistakable. */
export function AddressLink({ chain, address }: { chain: LoanChain; address: string }) {
  return (
    <a className={linkClass} href={chainAddressUrl(chain, address)} target="_blank" rel="noreferrer noopener">
      <span className="break-all font-mono text-xs">{address}</span>
      <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground">
        {explorerHost(chain)} <ExternalLink className="size-3" aria-hidden />
      </span>
    </a>
  );
}
