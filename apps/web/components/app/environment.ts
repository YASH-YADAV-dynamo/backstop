/** Browser environment sniffing for the mobile / in-app-browser notices (matrix rows 3-5). Client only. */

export type BrowserEnv = { mobile: boolean; inAppBrowser: string | null };

export function detectBrowser(): BrowserEnv {
  const ua = navigator.userAgent;
  const mobile = /Android|iPhone|iPad|iPod/i.test(ua);
  const inApp = /Telegram/i.test(ua)
    ? "Telegram"
    : /Twitter/i.test(ua)
      ? "X"
      : /FBAN|FBAV/i.test(ua)
        ? "Facebook"
        : /Instagram/i.test(ua)
          ? "Instagram"
          : /\bLine\//i.test(ua)
            ? "Line"
            : /Discord/i.test(ua)
              ? "Discord"
              : /; wv\)/.test(ua)
                ? "this app"
                : null;
  return { mobile, inAppBrowser: inApp };
}

/** MetaMask documents this deep-link form (docs.metamask.io, use-deeplinks). Other wallets' formats are unverified (U7) and not offered. */
export function metamaskDeepLink(url: string): string {
  return `https://link.metamask.io/dapp/${url.replace(/^https?:\/\//, "")}`;
}
