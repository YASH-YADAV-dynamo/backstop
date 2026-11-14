import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** The one card /dashboard shows when there is no vault to show: ask for a vault account (a plain GET form, no script needed). */
export function VaultPrompt({ heading, body, tone = "default", details, defaultValue }: { heading: string; body: string; tone?: "default" | "danger"; details?: string; defaultValue?: string }) {
  return (
    <Card className={tone === "danger" ? "border-danger/30" : undefined}>
      <CardHeader>
        <CardTitle className={`break-all text-base ${tone === "danger" ? "text-danger" : ""}`}>{heading}</CardTitle>
        <CardDescription role={tone === "danger" ? "alert" : undefined}>{body}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form action="/dashboard" method="get" className="space-y-2">
          <label htmlFor="vault-id" className="text-sm font-medium">
            Vault account
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id="vault-id"
              name="policy"
              defaultValue={defaultValue}
              placeholder="alice.backstop.near"
              spellCheck={false}
              autoComplete="off"
              className="h-10 w-full min-w-0 rounded-md border bg-background px-3 font-mono text-sm sm:flex-1"
            />
            <Button type="submit">Show</Button>
          </div>
        </form>
        <Link href="/app" className="inline-block text-sm underline underline-offset-4 hover:text-foreground">
          Open the app
        </Link>
        {details ? (
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Technical details</summary>
            <p className="mt-2 break-words text-muted-foreground">{details}</p>
          </details>
        ) : null}
      </CardContent>
    </Card>
  );
}
