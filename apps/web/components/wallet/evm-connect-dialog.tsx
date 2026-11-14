"use client";

import { ExternalLink, Loader2 } from "lucide-react";
import { Dialog } from "radix-ui";
import { useEffect, useMemo, useState } from "react";
import { useConnect, useConnectors } from "wagmi";
import { metamaskDeepLink } from "@/components/app/environment";
import { Button } from "@/components/ui/button";
import { useBrowserEnv, useHasBareProvider } from "@/lib/use-client";
import { isRequestPending, isUserRejection, errorText } from "@/lib/wallet-errors";

const INSTALL_LINKS = [
  { name: "MetaMask", href: "https://metamask.io" },
  { name: "Rabby", href: "https://rabby.io" },
  { name: "Coinbase Wallet", href: "https://www.coinbase.com/wallet" },
] as const;

const UNLOCK_HINT_MS = 30_000;

export function EvmConnectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const connectors = useConnectors();
  const { mutate: connect, reset, isPending, variables } = useConnect();
  const [message, setMessage] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const env = useBrowserEnv();
  const hasBareProvider = useHasBareProvider();

  useEffect(() => {
    if (!isPending) return;
    const t = setTimeout(() => setSlow(true), UNLOCK_HINT_MS);
    return () => {
      clearTimeout(t);
      setSlow(false);
    };
  }, [isPending]);

  // Row 9: list each EIP-6963 wallet by its announced name and icon; the bare `window.ethereum`
  // connector is only offered when no wallet announced itself.
  const list = useMemo(() => {
    const announced = connectors.filter((c) => c.type === "injected" && c.id !== "injected");
    const generic = connectors.filter((c) => c.id === "injected");
    const others = connectors.filter((c) => c.type !== "injected");
    return [...announced, ...(announced.length === 0 && hasBareProvider ? generic : []), ...others];
  }, [connectors, hasBareProvider]);

  const noWallet = list.length === 0;

  function pick(connector: (typeof connectors)[number]) {
    setMessage(null);
    // Called synchronously from the click handler (popup blockers).
    connect(
      { connector },
      {
        onSuccess: () => onOpenChange(false),
        onError: (err) => {
          if (isUserRejection(err)) setMessage("Cancelled in wallet. Pick a wallet to try again.");
          else if (isRequestPending(err)) setMessage("Your wallet already has a request open. Open it and approve or reject, then try again.");
          else setMessage(`Could not connect: ${errorText(err)}`);
        },
      },
    );
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          reset();
          setMessage(null);
        }
        onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border bg-popover p-5 text-popover-foreground shadow-xl">
          <Dialog.Title className="text-base font-semibold">Connect an EVM wallet</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-muted-foreground">
            Used only to read your address and to send ETH for gas on the chain your loan lives on. Backstop never asks for a key or a seed phrase.
          </Dialog.Description>

          <ul className="mt-4 space-y-2">
            {list.map((c) => {
              const connecting = isPending && variables?.connector === c;
              return (
                <li key={c.uid}>
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => pick(c)}
                    className="flex w-full items-center gap-3 rounded-lg border p-3 text-left text-sm transition-colors hover:bg-muted disabled:opacity-60"
                  >
                    {c.icon ? (
                      // eslint-disable-next-line @next/next/no-img-element -- wallet-supplied data: URI icon
                      <img src={c.icon} alt="" className="size-6 rounded" />
                    ) : (
                      <span className="size-6 rounded bg-muted" aria-hidden />
                    )}
                    <span className="flex-1 font-medium">{c.id === "injected" ? "Browser wallet" : c.name}</span>
                    {connecting ? <Loader2 className="size-4 animate-spin" aria-label="Waiting for your wallet" /> : null}
                  </button>
                </li>
              );
            })}
          </ul>

          {noWallet || list.every((c) => c.type !== "injected") ? (
            <div className="mt-4 rounded-lg border border-dashed p-3 text-sm">
              <p className="font-medium">No browser wallet found</p>
              <p className="mt-1 text-muted-foreground">Install one, then reload this page:</p>
              <ul className="mt-2 flex flex-wrap gap-2">
                {INSTALL_LINKS.map((l) => (
                  <li key={l.name}>
                    <a href={l.href} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs hover:bg-muted">
                      {l.name} <ExternalLink className="size-3" aria-hidden />
                    </a>
                  </li>
                ))}
              </ul>
              {env.mobile ? (
                <div className="mt-3 border-t pt-3">
                  <p className="text-muted-foreground">On a phone? Open this page inside your wallet&apos;s own browser.</p>
                  <Button asChild variant="outline" size="sm" className="mt-2">
                    <a href={metamaskDeepLink(window.location.href)} rel="noreferrer noopener">
                      Open in MetaMask
                    </a>
                  </Button>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Opened your wallet? Continue there. This tab can be closed.
                  </p>
                </div>
              ) : null}
              <p className="mt-3 text-xs text-muted-foreground">
                Or close this and choose &quot;Enter an address instead&quot; to look around read-only.
              </p>
            </div>
          ) : null}

          {slow && isPending ? (
            <p role="status" className="mt-3 text-sm text-warn">
              Still waiting. Unlock your wallet, then try again.{" "}
              <button type="button" className="underline" onClick={() => reset()}>
                Cancel
              </button>
            </p>
          ) : null}
          {message ? (
            <p role="alert" className="mt-3 text-sm text-muted-foreground">
              {message}
            </p>
          ) : null}

          <div className="mt-5 flex justify-end">
            <Dialog.Close asChild>
              <Button variant="ghost">Close</Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
