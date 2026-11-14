"use client";

import { formatUtc } from "@/lib/format";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { fetchInviteRequest, sendInviteRequest, VOLUME_BRACKETS, type VolumeBracket } from "@/lib/invite-api";
import { PUBLIC_ENV } from "@/lib/public-env";
import { cn } from "@/lib/utils";

const NOTE_MAX = 500;

const isBracket = (v: string | null): v is VolumeBracket => VOLUME_BRACKETS.some((b) => b.value === v);

function dateText(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "" : ` on ${formatUtc(new Date(t).toISOString())}`;
}

/**
 * Shown on the create card to a NEAR account that is not invited yet: ask for early access (an optional rough Aave
 * volume and a short note), or see that the request was already received. Asking grants nothing by itself.
 */
export function InviteRequestCard({ owner }: { owner: string }) {
  const queryClient = useQueryClient();
  const key = ["invite-request", owner];
  const existing = useQuery({ queryKey: key, queryFn: () => fetchInviteRequest(owner), staleTime: 60_000, retry: 1 });
  const [volume, setVolume] = useState<VolumeBracket | null>(null);
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState(false);
  const send = useMutation({
    mutationFn: () => sendInviteRequest({ account: owner, volume, note: note.trim() === "" ? null : note }),
    onSuccess: (request) => {
      queryClient.setQueryData(key, request);
      setEditing(false);
      return queryClient.invalidateQueries({ queryKey: key });
    },
  });
  const contact = PUBLIC_ENV.inviteContact ? (
    <p className="text-xs text-muted-foreground">
      Prefer email?{" "}
      <a href={PUBLIC_ENV.inviteContact} className="underline underline-offset-4 hover:text-foreground" rel="noopener noreferrer">
        {PUBLIC_ENV.inviteContact.replace(/^mailto:/i, "")}
      </a>
    </p>
  ) : null;

  if (existing.isPending) {
    return (
      <div className="space-y-2 rounded-xl border bg-muted/20 p-4" aria-busy="true">
        <p className="shimmer inline-block rounded text-sm text-muted-foreground">Checking your early access request...</p>
      </div>
    );
  }

  if (existing.data && !editing) {
    const received = existing.data;
    return (
      <div role="status" className="step-in space-y-3 rounded-xl border border-safe/40 bg-safe-bg p-4 text-sm">
        <p className="flex items-start gap-2 font-medium">
          <Check className="check-pop mt-0.5 size-4 shrink-0 text-safe" aria-hidden />
          <span>Request received{dateText(received.requestedAt)}. Thank you, we&apos;ll be in touch.</span>
        </p>
        <p className="break-words text-muted-foreground">
          Backstop is invite-only while we test with real money. Once <span className="break-all font-mono text-foreground">{owner}</span> is invited, the create form opens right here.
        </p>
        <button
          type="button"
          className="rounded text-xs underline underline-offset-4 hover:text-foreground"
          onClick={() => {
            setVolume(isBracket(received.volume) ? received.volume : null);
            send.reset();
            setEditing(true);
          }}
        >
          Update my request
        </button>
        {contact}
      </div>
    );
  }

  return (
    <form
      className="step-in space-y-4 rounded-xl border bg-muted/20 p-4 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        if (!send.isPending) send.mutate();
      }}
    >
      <div className="space-y-1">
        <h3 className="text-base font-semibold">Request early access</h3>
        <p className="text-muted-foreground">Backstop is in a small, careful beta while we test with real money. Tell us a little about you and we&apos;ll reach out.</p>
      </div>

      <label className="block space-y-1">
        <span className="font-medium">Your NEAR account</span>
        <input value={owner} readOnly aria-readonly className="h-10 w-full min-w-0 rounded-md border bg-muted/40 px-3 font-mono text-sm text-muted-foreground" />
      </label>

      <div className="space-y-2">
        <p id="invite-volume" className="font-medium">
          How much have you lent or borrowed on Aave so far? <span className="font-normal text-muted-foreground">(optional)</span>
        </p>
        <div role="radiogroup" aria-labelledby="invite-volume" className="flex flex-wrap gap-2">
          {VOLUME_BRACKETS.map((b) => {
            const on = volume === b.value;
            return (
              <button
                key={b.value}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setVolume(on ? null : b.value)}
                className={cn(
                  "inline-flex h-9 items-center rounded-full border px-3 text-sm transition-[color,background-color,border-color,transform] duration-200 active:scale-[0.97] motion-reduce:active:scale-100",
                  on ? "border-primary bg-primary/15 font-medium text-foreground" : "text-muted-foreground hover:border-foreground/30 hover:text-foreground",
                )}
              >
                {b.label}
              </button>
            );
          })}
        </div>
      </div>

      <label className="block space-y-1">
        <span className="font-medium">
          Anything you&apos;d like us to know? <span className="font-normal text-muted-foreground">(optional)</span>
        </span>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={NOTE_MAX}
          rows={3}
          placeholder="For example, the best way to reach you (email, Telegram or X)."
          className="w-full min-w-0 rounded-md border bg-background px-3 py-2 text-sm transition-[border-color,box-shadow] duration-200 hover:border-foreground/30 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
        <span className="block text-right text-xs text-muted-foreground">
          {note.length} / {NOTE_MAX}
        </span>
      </label>

      {send.isError ? (
        <p role="alert" className="break-words text-danger">
          {send.error instanceof Error ? send.error.message : "The request could not be sent. Try again."}
        </p>
      ) : null}
      {existing.isError ? <p className="text-xs text-muted-foreground">We could not check whether you already asked. Sending again is fine.</p> : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={send.isPending}>
          {send.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {send.isPending ? "Sending..." : existing.data ? "Update request" : "Request invite"}
        </Button>
        {editing ? (
          <button type="button" className="rounded text-xs underline underline-offset-4 hover:text-foreground" onClick={() => setEditing(false)}>
            Cancel
          </button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">We only store what you type here. Asking does not create a vault or move any funds.</p>
      {contact}
    </form>
  );
}
