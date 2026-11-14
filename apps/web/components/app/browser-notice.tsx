"use client";

import { Info } from "lucide-react";
import { useBrowserEnv } from "@/lib/use-client";

/** Row 5: wallet popups and deep links are unreliable inside chat apps' built-in browsers. */
export function BrowserNotice() {
  const app = useBrowserEnv().inAppBrowser;
  if (!app) return null;
  return (
    <div role="note" className="flex gap-3 rounded-lg border border-warn/30 bg-warn/5 p-4 text-sm">
      <Info className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
      <p>
        You are in {app}&apos;s built-in browser. Wallet popups often fail here. Open this page in Safari or Chrome, or inside your
        wallet&apos;s own browser. You can still read everything.
      </p>
    </div>
  );
}
