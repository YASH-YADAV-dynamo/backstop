"use client";

import { CircleAlert, CircleCheck, X } from "lucide-react";
import { useSyncExternalStore } from "react";

type Toast = { id: number; tone: "success" | "error" | "info"; message: string };

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function add(tone: Toast["tone"], message: string): void {
  const id = nextId++;
  toasts = [...toasts, { id, tone, message }].slice(-4);
  emit();
  // Errors stay until dismissed (v3 section 3); the rest leave on their own.
  if (tone !== "error") setTimeout(() => dismiss(id), 8_000);
}

function dismiss(id: number): void {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

/** Call from any client code. Messages are one calm sentence; never an internal term. */
export const toast = {
  success: (message: string) => add("success", message),
  info: (message: string) => add("info", message),
  error: (message: string) => add("error", message),
};

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => void listeners.delete(cb);
};

/** One host for all toasts: bottom of the screen, above the page, announced to screen readers. */
export function Toaster() {
  const list = useSyncExternalStore(subscribe, () => toasts, () => toasts);
  if (list.length === 0) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4" role="region" aria-label="Notifications">
      {list.map((t) => (
        <div
          key={t.id}
          role={t.tone === "error" ? "alert" : "status"}
          className="toast-in pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-xl border bg-popover p-3 text-sm text-popover-foreground shadow-[var(--shadow-card)]"
        >
          {t.tone === "error" ? <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden /> : <CircleCheck className="mt-0.5 size-4 shrink-0 text-safe" aria-hidden />}
          <p className="min-w-0 flex-1 break-words">{t.message}</p>
          <button type="button" onClick={() => dismiss(t.id)} aria-label="Dismiss" className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground">
            <X className="size-4" aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}
