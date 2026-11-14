"use client";

import { ExternalLink, Loader2 } from "lucide-react";
import { Dialog } from "radix-ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { useConnect, useConnectors } from "wagmi";
import { metamaskDeepLink } from "@/components/app/environment";
import { Button } from "@/components/ui/button";
import { useBrowserEnv, useHasBareProvider } from "@/lib/use-client";
import { walletErrorMessage } from "@/lib/wallet-errors";
import { createInFlightGuard, evmWalletChoices, WALLET_STALL_MS } from "@/lib/wallet-flow";

const INSTALL_LINKS = [
  { name: "MetaMask", href: "https://metamask.io" },
  { name: "Rabby", href: "https://rabby.io" },
  { name: "Coinbase Wallet", href: "https://www.coinbase.com/wallet" },
] as const;

export function EvmConnectDialog({
  open,
  onOpenChange,
  onConnected,
  only,
  description = "Used to read your address and to send only what you approve in your wallet. Backstop never asks for a key or a seed phrase.",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Runs after the wallet connected, before the dialog closes. */
  onConnected?: () => void;
  /** Show only wallets whose name matches (e.g. /metamask|rabby/i); install links are narrowed the same way. */
  only?: RegExp;
  description?: string;
}) {
  const connectors = useConnectors();
  const { mutate: connect, reset, isPending, variables } = useConnect();
  const [message, setMessage] = useState<string | null>(null);
  /** The wallet to offer "Try again" for after an open-request error. */
  const [retryWith, setRetryWith] = useState<(typeof connectors)[number] | null>(null);
  const [slow, setSlow] = useState(false);
  const guard = useRef(createInFlightGuard());
  const env = useBrowserEnv();
  const hasBareProvider = useHasBareProvider();

  useEffect(() => {
    if (!isPending) return;
    const t = setTimeout(() => setSlow(true), WALLET_STALL_MS);
    return () => {
      clearTimeout(t);
      setSlow(false);
    };
  }, [isPending]);

  // Row 9: list each EIP-6963 wallet by its announced name and icon; the bare `window.ethereum`
  // connector is only offered when no wallet announced itself (it belongs to whichever extension won the race).
  const list = useMemo(() => {
    const all = evmWalletChoices(connectors, hasBareProvider);
    return only ? all.filter((c) => only.test(c.name)) : all;
  }, [connectors, hasBareProvider, only]);
  const installLinks = only ? INSTALL_LINKS.filter((l) => only.test(l.name)) : INSTALL_LINKS;

  const noWallet = list.length === 0;

  function pick(connector: (typeof connectors)[number]) {
    const token = guard.current.begin();
    if (token === null) return; // a double click must not open a second wallet request
    setMessage(null);
    setRetryWith(null);
    // Called synchronously from the click handler (popup blockers).
    connect(
      { connector },
      {
        onSuccess: () => {
          if (!guard.current.end(token)) return;
          onConnected?.();
          onOpenChange(false);
        },
        onError: (err) => {
          if (!guard.current.end(token)) return; // the user stopped waiting: this answer is stale
          const { kind, message: text } = walletErrorMessage(err, "Could not connect");
          if (kind === "rejected") setMessage("Cancelled in wallet. Pick a wallet to try again.");
          else setMessage(text);
          if (kind === "pending") setRetryWith(connector);
        },
      },
    );
  }

  function stopWaiting() {
    guard.current.reset();
    reset();
    setMessage("Stopped waiting. If your wallet still shows a connection request, finish or reject it there, then pick a wallet again.");
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          guard.current.reset();
          reset();
          setMessage(null);
          setRetryWith(null);
        }
        onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border bg-popover p-5 text-popover-foreground shadow-xl">
          <Dialog.Title className="text-base font-semibold">{only ? `Connect ${installLinks.map((l) => l.name).join(" or ")}` : "Connect a wallet"}</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-muted-foreground">
            {description}
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
              <p className="font-medium">{only ? `${installLinks.map((l) => l.name).join(" or ")} not found in this browser` : "No browser wallet found"}</p>
              <p className="mt-1 text-muted-foreground">{only && connectors.some((c) => c.type === "injected" && c.id !== "injected") ? "Another wallet is installed, but it is not supported here. Install one of these, then reload this page:" : "Install one, then reload this page:"}</p>
              <ul className="mt-2 flex flex-wrap gap-2">
                {installLinks.map((l) => (
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
                  <p className="mt-2 text-xs text-muted-foreground">
                    Using Rabby on a phone? We can only open MetaMask for you. Open this page from the browser inside the Rabby app, or use a computer.
                  </p>
                </div>
              ) : null}
              <p className="mt-3 text-xs text-muted-foreground">
                No wallet? Close this and type your loan address by hand. A wallet is only needed to send.
              </p>
            </div>
          ) : null}

          {slow && isPending ? (
            <p role="status" className="mt-3 text-sm text-warn">
              Still waiting for your wallet. Unlock it and look for the request.{" "}
              <button type="button" className="underline" onClick={stopWaiting}>
                Stop waiting
              </button>
            </p>
          ) : null}
          {message ? (
            <div role="alert" className="mt-3 space-y-2 text-sm text-muted-foreground">
              <p>{message}</p>
              {retryWith && !isPending ? (
                <Button size="sm" variant="outline" onClick={() => pick(retryWith)}>
                  Try again
                </Button>
              ) : null}
            </div>
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
