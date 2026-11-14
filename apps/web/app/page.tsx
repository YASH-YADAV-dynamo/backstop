import { ArrowRight, Check } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { ChainChip, ChainLogo, type ChainLogoKey } from "@/components/landing/chain-logo";
import { HeroRescue } from "@/components/landing/hero-rescue";
import { ContainedIcon, LimitsIcon, NoKeyIcon, RepayIcon, VaultIcon, WatchIcon } from "@/components/landing/icons";
import { Reveal } from "@/components/landing/reveal";
import { RescueHistory } from "@/components/rescue-table";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { getHistory } from "@/lib/data";
import type { RescueRow, Section as LoadedSection } from "@/lib/dashboard-types";
import { SITE } from "@/lib/site";

/** Re-read the rescue history at most once a minute. */
export const revalidate = 60;

const TICKS = ["You set the limits", "Only you can withdraw", "Pause any time"];

/** Product terms, not traction numbers. */
const FACTS = [
  { value: "0.10%", label: "Fee, only when money is moved" },
  { value: "~3 NEAR", label: "Refundable deposit while your vault is open" },
  { value: "30 s", label: "How often your loan is checked" },
  { value: "0", label: "Private keys on your rescue wallet" },
];

const STEPS: { icon: typeof VaultIcon; title: string; body: string; chains: ChainLogoKey[] }[] = [
  { icon: VaultIcon, title: "Open a vault and add USDC", body: "The vault is yours. It holds the spare USDC Backstop may use, and only you can take it out.", chains: ["near"] },
  { icon: WatchIcon, title: "We watch your loan every 30 seconds", body: "You pick the level at which Backstop steps in, for example when your loan health drops below 1.15.", chains: ["base", "arbitrum"] },
  { icon: RepayIcon, title: "If it gets risky, we repay part of it and show you a receipt", body: "Every rescue stays inside the limits you set and comes with a plain-English receipt and links.", chains: [] },
];

const SAFETY = [
  { icon: NoKeyIcon, title: "No one holds a key to your rescue money", body: "Your rescue wallet has no private key at all. Only your vault's rules can move it, and only to repay your loan." },
  { icon: LimitsIcon, title: "Your limits are enforced on NEAR", body: "How low health may fall, how much one rescue repays, how much per day and how often are checked by code you can read, not by a promise." },
  { icon: ContainedIcon, title: "The worst case is small", body: "A hacked bot could only repay your own debt early, inside your limits. It cannot send your money anywhere else." },
];

const UNDER_THE_HOOD: { label: string; href: string; chain?: ChainLogoKey }[] = [
  { label: "Aave v3 on Base", href: "/docs/overview", chain: "base" },
  { label: "Aave v3 on Arbitrum One", href: "/docs/overview", chain: "arbitrum" },
  { label: "Vault and rules on NEAR", href: "/docs/policy-contract", chain: "near" },
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

const GRID_BG = {
  backgroundImage:
    "linear-gradient(to right, var(--color-border) 1px, transparent 1px), linear-gradient(to bottom, var(--color-border) 1px, transparent 1px)",
  backgroundSize: "64px 64px",
} as const;

const CARD = "group relative h-full overflow-hidden rounded-2xl border bg-card/70 p-6 transition-colors duration-300 hover:border-primary/50 sm:p-7";
const ICON_TILE = "grid size-12 place-items-center rounded-xl border border-primary/30 bg-primary/10 text-primary shadow-[0_0_28px_-8px_var(--color-primary)]";

/** A thin light along the top edge of a card that brightens on hover. */
function CardEdge() {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-primary to-transparent opacity-30 transition-opacity duration-300 group-hover:opacity-100"
    />
  );
}

function SectionBlock({ id, eyebrow, title, lead, children }: { id?: string; eyebrow: string; title: string; lead?: string; children: ReactNode }) {
  return (
    <section id={id} className="mx-auto w-full max-w-6xl scroll-mt-20 px-4 py-14 sm:py-24">
      <Reveal>
        <p className="eyebrow flex items-center gap-3 text-primary">
          <span className="h-px w-8 bg-primary" aria-hidden />
          {eyebrow}
        </p>
        <h2 className="font-display mt-4 max-w-3xl text-[1.9rem] sm:text-5xl">{title}</h2>
        {lead ? <p className="mt-4 max-w-2xl text-muted-foreground sm:text-lg">{lead}</p> : null}
      </Reveal>
      <div className="mt-9 sm:mt-12">{children}</div>
    </section>
  );
}

/** The newest completed mainnet rescue that has a repay transaction link, or null. No link, no number. */
function lastProvenRescue(history: LoadedSection<RescueRow[]>): RescueRow | null {
  if (history.state !== "ok") return null;
  return history.data.find((r) => !r.dryRun && r.status === "success" && r.hfAfter !== null && Boolean(r.links.baseRepayTx)) ?? null;
}

export default async function Home() {
  const history = await getHistory();
  const last = lastProvenRescue(history);
  const mainnetRows: LoadedSection<RescueRow[]> | null =
    history.state === "ok" && history.data.some((r) => !r.dryRun) ? { state: "ok", data: history.data.filter((r) => !r.dryRun) } : null;

  return (
    <div className="overflow-x-clip">
      <section className="relative isolate">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 opacity-40"
          style={{
            ...GRID_BG,
            maskImage: "radial-gradient(75% 60% at 50% 25%, black, transparent)",
            WebkitMaskImage: "radial-gradient(75% 60% at 50% 25%, black, transparent)",
          }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -top-40 -z-10 h-[38rem]"
          style={{ background: "radial-gradient(50% 60% at 50% 30%, color-mix(in oklab, var(--color-primary) 20%, transparent), transparent 75%)" }}
        />

        <div className="mx-auto grid w-full max-w-6xl items-center gap-10 px-4 pt-10 pb-12 sm:pt-14 sm:pb-16 lg:grid-cols-[0.74fr_1.26fr] lg:gap-12">
          <div className="min-w-0">
            <p className="inline-flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-full border bg-card/70 px-3.5 py-1.5 text-xs text-muted-foreground backdrop-blur sm:text-sm">
              For Aave loans on
              <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                <ChainLogo chain="base" className="h-3.5" /> Base
              </span>
              <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                <ChainLogo chain="arbitrum" className="h-4" /> Arbitrum One
              </span>
            </p>
            <h1 className="font-display mt-6 text-[clamp(2.5rem,7vw,4.5rem)] lg:text-[3.6rem]">
              Save your loan{" "}
              <span className="bg-gradient-to-r from-primary via-primary to-warn bg-clip-text text-transparent">before it is liquidated.</span>
            </h1>
            <p className="mt-5 max-w-[52ch] text-lg text-muted-foreground">
              When your loan&apos;s health drops, Backstop moves your spare USDC from NEAR to your loan and repays part of it. Health
              recovers and you keep your collateral.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button asChild size="lg" className="w-full shadow-[0_0_32px_-6px_var(--color-primary)] sm:w-auto">
                <Link href="/app">
                  Protect my loan <ArrowRight aria-hidden />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline" className="w-full bg-card/60 backdrop-blur sm:w-auto">
                <Link href="#how">See how it works</Link>
              </Button>
            </div>
            <ul className="flex flex-col gap-2 text-sm lg:mt-8">
              {TICKS.map((t) => (
                <li key={t} className="hidden items-center gap-2 lg:flex">
                  <Check className="size-4 text-safe" aria-hidden />
                  {t}
                </li>
              ))}
              {last ? (
                <li>
                  <span className="text-muted-foreground">Last rescue: </span>
                  <a href={last.links.baseRepayTx} target="_blank" rel="noreferrer" className="num font-medium text-primary hover:underline">
                    {last.amountUsdc} USDC, health {last.hfBefore} → {last.hfAfter}
                  </a>
                </li>
              ) : null}
            </ul>
          </div>
          <HeroRescue />
        </div>
      </section>

      <section aria-label="The terms" className="border-y bg-muted/30">
        <dl className="mx-auto grid w-full max-w-6xl grid-cols-2 lg:grid-cols-4">
          {FACTS.map((f, i) => (
            <div key={f.label} className={`flex flex-col-reverse justify-end gap-2 px-4 py-6 sm:py-8 ${i % 2 ? "border-l" : ""} ${i > 1 ? "border-t lg:border-t-0" : ""} ${i === 2 ? "lg:border-l" : ""}`}>
              <dt className="text-sm text-muted-foreground">{f.label}</dt>
              <dd className="font-display text-3xl sm:text-4xl">{f.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <SectionBlock id="how" eyebrow="How it works" title="Three steps. Then it watches for you.">
        <ol className="grid gap-4 md:grid-cols-3">
          {STEPS.map((s, i) => (
            <li key={s.title}>
              <Reveal delay={i * 90} className="h-full">
                <div className={`${CARD} flex flex-col`}>
                  <CardEdge />
                  <div className="flex items-center justify-between">
                    <span className={ICON_TILE}>
                      <s.icon className="size-6" />
                    </span>
                    <span className="font-display text-4xl text-foreground/10">0{i + 1}</span>
                  </div>
                  <h3 className="font-display mt-6 text-xl leading-tight sm:text-[1.4rem]">{s.title}</h3>
                  <p className="mt-3 text-sm text-muted-foreground sm:text-base">{s.body}</p>
                  {s.chains.length > 0 ? (
                    <div className="mt-auto flex flex-wrap gap-2 pt-6">
                      {s.chains.map((c) => (
                        <ChainChip key={c} chain={c} />
                      ))}
                    </div>
                  ) : null}
                </div>
              </Reveal>
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

      <div className="relative isolate">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10"
          style={{ background: "radial-gradient(45% 50% at 85% 40%, color-mix(in oklab, var(--color-primary) 10%, transparent), transparent 75%)" }}
        />
        <SectionBlock id="safety" eyebrow="Safety" title="Built so it can only repay your loan.">
          <div className="grid gap-4 md:grid-cols-3">
            {SAFETY.map((s, i) => (
              <Reveal key={s.title} delay={i * 90} className="h-full">
                <div className={`${CARD} ${i === 2 ? "border-primary/40 bg-gradient-to-b from-primary/15 to-card/70" : ""}`}>
                  <CardEdge />
                  <span className={ICON_TILE}>
                    <s.icon className="size-6" />
                  </span>
                  <h3 className="font-display mt-6 text-xl leading-tight sm:text-[1.4rem]">{s.title}</h3>
                  <p className="mt-3 text-sm text-muted-foreground sm:text-base">{s.body}</p>
                </div>
              </Reveal>
            ))}
          </div>
          <div className="mt-10">
            <p className="eyebrow text-muted-foreground">Under the hood</p>
            <ul className="mt-4 flex flex-wrap gap-2 text-sm">
              {UNDER_THE_HOOD.map((u) => (
                <li key={u.label}>
                  <Link
                    href={u.href}
                    className="inline-flex items-center gap-2 rounded-full border bg-card/60 px-3 py-1.5 transition-colors hover:border-primary hover:text-primary"
                  >
                    {u.chain ? <ChainLogo chain={u.chain} className="h-4" /> : null}
                    {u.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </SectionBlock>
      </div>

      {mainnetRows ? (
        <SectionBlock id="history" eyebrow="Rescue history" title="Every rescue, on the record.">
          <RescueHistory history={mainnetRows} chain={null} />
        </SectionBlock>
      ) : null}

      <section className="mx-auto grid w-full max-w-6xl gap-9 px-4 py-14 sm:py-24 lg:grid-cols-[0.8fr_1.2fr] lg:gap-14">
        <Reveal>
          <p className="eyebrow flex items-center gap-3 text-primary">
            <span className="h-px w-8 bg-primary" aria-hidden />
            FAQ
          </p>
          <h2 className="font-display mt-4 text-[1.9rem] sm:text-5xl">Questions.</h2>
          <p className="mt-4 max-w-sm text-muted-foreground">
            The longer answers are in the{" "}
            <Link href="/docs" className="font-medium text-primary hover:underline">
              docs
            </Link>
            , and all of the code is{" "}
            <a href={SITE.repoUrl} className="font-medium text-primary hover:underline">
              open source
            </a>
            .
          </p>
        </Reveal>
        <Accordion type="single" collapsible className="rounded-2xl border bg-card/70 px-5 sm:px-6">
          {FAQ.map((f) => (
            <AccordionItem key={f.q} value={f.q}>
              <AccordionTrigger>{f.q}</AccordionTrigger>
              <AccordionContent>{f.a}</AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </section>

      <section className="mx-auto w-full max-w-6xl px-4 pb-14 sm:pb-24">
        <div className="relative isolate overflow-hidden rounded-3xl border border-primary/30 bg-card px-6 py-12 sm:px-12 sm:py-20 sm:text-center">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10 opacity-40"
            style={{
              ...GRID_BG,
              maskImage: "radial-gradient(70% 90% at 50% 100%, black, transparent)",
              WebkitMaskImage: "radial-gradient(70% 90% at 50% 100%, black, transparent)",
            }}
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10"
            style={{ background: "radial-gradient(60% 90% at 50% 110%, color-mix(in oklab, var(--color-primary) 32%, transparent), transparent 70%)" }}
          />
          <h2 className="font-display mx-auto max-w-2xl text-[1.9rem] sm:text-5xl">Put a backstop under your loan.</h2>
          <p className="mt-4 text-muted-foreground sm:text-lg">Set your limits once. Pause or withdraw any time.</p>
          <Button asChild size="lg" className="mt-8 w-full shadow-[0_0_32px_-6px_var(--color-primary)] sm:w-auto">
            <Link href="/app">
              Protect my loan <ArrowRight aria-hidden />
            </Link>
          </Button>
        </div>
      </section>
    </div>
  );
}
