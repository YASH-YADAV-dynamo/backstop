import { ArrowRight, Check, Eye, KeyRound, ReceiptText, ShieldAlert, SlidersHorizontal, Vault } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { HeroRescue } from "@/components/landing/hero-rescue";
import { RescueHistory } from "@/components/rescue-table";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { getHistory } from "@/lib/data";
import type { RescueRow, Section as LoadedSection } from "@/lib/dashboard-types";
import { SITE } from "@/lib/site";

/** Re-read the rescue history at most once a minute. */
export const revalidate = 60;

const TICKS = ["You set the limits", "Only you can withdraw", "Pause any time"];

const STEPS = [
  { icon: Vault, title: "Open a vault and add USDC", body: "The vault is yours. It holds the spare USDC Backstop may use, and only you can take it out." },
  { icon: Eye, title: "We watch your loan every 30 seconds", body: "You pick the level at which Backstop steps in, for example when your loan health drops below 1.15." },
  { icon: ReceiptText, title: "If it gets risky, we repay part of it and show you a receipt", body: "Every rescue stays inside the limits you set and comes with a plain-English receipt and links." },
];

const SAFETY = [
  { icon: KeyRound, title: "No one holds a key to your rescue money", body: "Your rescue wallet has no private key at all. Only your vault's rules can move it, and only to repay your loan." },
  { icon: SlidersHorizontal, title: "Your limits are enforced on NEAR", body: "How low health may fall, how much one rescue repays, how much per day and how often are checked by code you can read, not by a promise." },
  { icon: ShieldAlert, title: "The worst case is small", body: "A hacked bot could only repay your own debt early, inside your limits. It cannot send your money anywhere else." },
];

const UNDER_THE_HOOD = [
  { label: "Aave v3 on Base", href: "/docs/overview" },
  { label: "Aave v3 on Arbitrum One", href: "/docs/overview" },
  { label: "Vault and rules on NEAR", href: "/docs/policy-contract" },
  { label: "NEAR Chain Signatures", href: "/docs/security-model" },
  { label: "NEAR Intents (1Click)", href: "/docs/how-a-rescue-works" },
  { label: "Architecture", href: "/docs/architecture" },
  { label: "Security model", href: "/docs/security-model" },
];

const FAQ = [
  { q: "What does it cost?", a: "Backstop takes 0.10% of the USDC moved in a rescue, plus the network fees. Opening a vault holds about 3 NEAR, which you get back when you close it. The app shows the exact amounts before you confirm." },
  { q: "Can I get my money out?", a: "Yes, any time. Only your NEAR account can withdraw USDC from your vault. Money already moved to your loan chain for a rescue is used to repay your loan." },
  { q: "How fast is a rescue?", a: "A minute or two. A very fast crash can still beat it, so pick a trigger with room to spare. See Risks and limits." },
  { q: "What if Backstop goes offline?", a: "Then nothing is repaid, and the app says so instead of showing you as protected. Your money stays in your vault, and you can pause or withdraw at any time." },
  { q: "Do I need NEAR?", a: "Yes, a little: the vault lives on NEAR and holds about 3 NEAR while it is open. The USDC itself can come from your NEAR wallet or from another chain." },
  { q: "Does Backstop hold my money?", a: "No. Your USDC sits in a vault owned by your NEAR account. Nobody at Backstop can withdraw it." },
  { q: "What if Backstop is hacked?", a: "The vault accepts only rescue calls from the bot. The worst case is that your own debt is repaid early with your own USDC, inside your limits." },
  { q: "What if a rescue is not enough?", a: "Backstop repays up to your limits. The dashboard shows your loan health so you can add collateral or repay yourself." },
  { q: "Is it audited?", a: "Not yet. Backstop is in beta. Its smart contracts are open source and not yet audited, so start with an amount you are comfortable with. See Risks and limits." },
];

function SectionBlock({ id, eyebrow, title, children }: { id?: string; eyebrow: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="mx-auto w-full max-w-6xl scroll-mt-28 px-4 py-12 sm:py-16">
      <p className="eyebrow text-primary">{eyebrow}</p>
      <h2 className="font-display mt-3 max-w-3xl text-[1.75rem] sm:text-[2.75rem]">{title}</h2>
      <div className="mt-8 sm:mt-10">{children}</div>
    </section>
  );
}

/** The newest completed mainnet rescue that has a repay transaction link, or null. No link, no number. */
function lastProvenRescue(history: LoadedSection<RescueRow[]>): RescueRow | null {
  if (history.state !== "ok") return null;
  return history.data.find((r) => !r.dryRun && r.status === "success" && r.hfAfter !== null && Boolean(r.links.baseRepayTx)) ?? null;
}

function ProofStrip({ last }: { last: RescueRow | null }) {
  return (
    <div className="border-y bg-muted/40">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 py-4 text-sm sm:flex-row sm:items-center sm:justify-between">
        {last ? (
          <p>
            <span className="text-muted-foreground">Last rescue: </span>
            <a href={last.links.baseRepayTx} target="_blank" rel="noreferrer" className="num font-medium text-primary hover:underline">
              {last.amountUsdc} USDC, health {last.hfBefore} → {last.hfAfter}
            </a>
          </p>
        ) : (
          <p className="text-muted-foreground">
            <span className="font-medium text-foreground">0.10% fee, only when money is moved.</span> Pause or withdraw any time.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <span className="flex items-center gap-2 text-muted-foreground">
            <span className="size-2 rounded-full bg-chain-base" aria-hidden /> Base
          </span>
          <span className="flex items-center gap-2 text-muted-foreground">
            <span className="size-2 rounded-full bg-chain-arbitrum" aria-hidden /> Arbitrum One
          </span>
          <a href={SITE.repoUrl} className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
            View the code <ArrowRight className="size-4" aria-hidden />
          </a>
        </div>
      </div>
    </div>
  );
}

export default async function Home() {
  const history = await getHistory();
  const last = lastProvenRescue(history);
  const mainnetRows: LoadedSection<RescueRow[]> | null =
    history.state === "ok" && history.data.some((r) => !r.dryRun) ? { state: "ok", data: history.data.filter((r) => !r.dryRun) } : null;

  return (
    <div className="overflow-x-clip">
      <section className="relative">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 opacity-[0.35]"
          style={{
            backgroundImage:
              "linear-gradient(to right, var(--color-border) 1px, transparent 1px), linear-gradient(to bottom, var(--color-border) 1px, transparent 1px)",
            backgroundSize: "56px 56px",
            maskImage: "radial-gradient(70% 70% at 50% 30%, black, transparent)",
            WebkitMaskImage: "radial-gradient(70% 70% at 50% 30%, black, transparent)",
          }}
        />
        <div className="mx-auto grid w-full max-w-6xl items-center gap-10 px-4 pt-10 pb-12 sm:pt-16 sm:pb-16 lg:grid-cols-[1.05fr_1fr] lg:gap-14">
          <div className="min-w-0">
            <p className="inline-flex items-center gap-2 rounded-full border bg-card px-3 py-1 text-xs text-muted-foreground sm:text-sm">
              <span className="size-1.5 rounded-full bg-primary" aria-hidden />
              For Aave loans on Base and Arbitrum
            </p>
            <h1 className="font-display mt-5 text-[clamp(2.5rem,6vw,5rem)]">Save your loan before it is liquidated.</h1>
            <p className="mt-5 max-w-[52ch] text-lg text-muted-foreground">
              When your loan&apos;s health drops, Backstop moves your spare USDC from NEAR to your loan and repays part of it.
              Health recovers and you keep your collateral.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button asChild size="lg" className="w-full sm:w-auto">
                <Link href="/app">
                  Protect my loan <ArrowRight aria-hidden />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline" className="w-full sm:w-auto">
                <Link href="#how">See how it works</Link>
              </Button>
            </div>
            <ul className="mt-8 flex flex-col gap-2 text-sm sm:flex-row sm:flex-wrap sm:gap-x-6">
              {TICKS.map((t) => (
                <li key={t} className="flex items-center gap-2">
                  <Check className="size-4 text-safe" aria-hidden />
                  {t}
                </li>
              ))}
            </ul>
          </div>
          <HeroRescue />
        </div>
      </section>

      <ProofStrip last={last} />

      <SectionBlock id="how" eyebrow="How it works" title="Three steps. Then it watches for you.">
        <ol className="grid gap-4 md:grid-cols-3">
          {STEPS.map((s, i) => (
            <li key={s.title} className="relative rounded-2xl border bg-card p-6">
              <div className="flex items-center justify-between">
                <span className="grid size-11 place-items-center rounded-xl bg-accent text-accent-foreground">
                  <s.icon className="size-5" aria-hidden />
                </span>
                <span className="num text-sm text-muted-foreground">0{i + 1}</span>
              </div>
              <h3 className="font-display mt-5 text-xl leading-tight">{s.title}</h3>
              <p className="mt-3 text-sm text-muted-foreground">{s.body}</p>
            </li>
          ))}
        </ol>
        <p className="mt-6 text-sm text-muted-foreground">
          A rescue takes a minute or two. Very fast crashes can still beat it.{" "}
          <Link href="/docs/risks-and-limits" className="font-medium text-primary hover:underline">
            Read the risks
          </Link>
        </p>
      </SectionBlock>

      <SectionBlock id="safety" eyebrow="Safety" title="Built so it can only repay your loan.">
        <div className="grid gap-4 md:grid-cols-3">
          {SAFETY.map((s, i) => (
            <div key={s.title} className={`rounded-2xl border p-6 ${i === 2 ? "border-primary/40 bg-accent text-accent-foreground" : "bg-card"}`}>
              <s.icon className={`size-6 ${i === 2 ? "" : "text-primary"}`} aria-hidden />
              <h3 className="font-display mt-4 text-xl leading-tight">{s.title}</h3>
              <p className={`mt-3 text-sm ${i === 2 ? "" : "text-muted-foreground"}`}>{s.body}</p>
            </div>
          ))}
        </div>
        <div className="mt-8">
          <p className="eyebrow text-muted-foreground">Under the hood</p>
          <ul className="mt-3 flex flex-wrap gap-2 text-sm">
            {UNDER_THE_HOOD.map((u) => (
              <li key={u.label}>
                <Link href={u.href} className="inline-flex rounded-full border bg-card px-3 py-1.5 transition-colors hover:border-primary hover:text-primary">
                  {u.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </SectionBlock>

      {mainnetRows ? (
        <SectionBlock id="history" eyebrow="Rescue history" title="Every rescue, on the record.">
          <RescueHistory history={mainnetRows} chain={null} />
        </SectionBlock>
      ) : null}

      <SectionBlock eyebrow="FAQ" title="Questions.">
        <Accordion type="single" collapsible className="max-w-3xl rounded-2xl border bg-card px-5">
          {FAQ.map((f) => (
            <AccordionItem key={f.q} value={f.q}>
              <AccordionTrigger>{f.q}</AccordionTrigger>
              <AccordionContent>{f.a}</AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </SectionBlock>

      <section className="border-t bg-muted/40">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-start gap-6 px-4 py-12 sm:flex-row sm:items-center sm:justify-between sm:py-16">
          <div>
            <h2 className="font-display max-w-xl text-[1.75rem] sm:text-4xl">Put a backstop under your loan.</h2>
            <p className="mt-3 text-muted-foreground">Set your limits once. Pause or withdraw any time.</p>
          </div>
          <Button asChild size="lg">
            <Link href="/app">
              Protect my loan <ArrowRight aria-hidden />
            </Link>
          </Button>
        </div>
      </section>
    </div>
  );
}
