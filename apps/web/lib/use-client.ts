"use client";

import { useSyncExternalStore } from "react";
import { detectBrowser, type BrowserEnv } from "@/components/app/environment";

const noopSubscribe = () => () => {};
const SERVER_ENV: BrowserEnv = { mobile: false, inAppBrowser: null };
let cachedEnv: BrowserEnv | null = null;

/** False during SSR and the first client render, true afterwards (no hydration mismatch). */
export function useMounted(): boolean {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}

/** User-agent derived facts; stable object identity. */
export function useBrowserEnv(): BrowserEnv {
  return useSyncExternalStore(
    noopSubscribe,
    () => (cachedEnv ??= detectBrowser()),
    () => SERVER_ENV,
  );
}

/** Whether a bare `window.ethereum` exists (some wallets inject only that). */
export function useHasBareProvider(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => typeof (window as { ethereum?: unknown }).ethereum !== "undefined",
    () => false,
  );
}

const localListeners = new Set<() => void>();

/** A string kept in localStorage (per-viewer convenience only; never state that must be reliable). Null when unset or storage is blocked. */
export function useLocalString(key: string | null): [string | null, (value: string | null) => void] {
  const value = useSyncExternalStore(
    (cb) => {
      localListeners.add(cb);
      window.addEventListener("storage", cb);
      return () => {
        localListeners.delete(cb);
        window.removeEventListener("storage", cb);
      };
    },
    () => {
      if (!key) return null;
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    () => null,
  );
  const set = (next: string | null) => {
    if (!key) return;
    try {
      if (next === null) localStorage.removeItem(key);
      else localStorage.setItem(key, next);
    } catch {
      // Blocked storage: the choice just is not remembered.
    }
    localListeners.forEach((cb) => cb());
  };
  return [value, set];
}
