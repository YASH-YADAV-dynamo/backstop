import { ArrowRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { ChainChip, ChainLogo, type ChainLogoKey } from "@/components/landing/chain-logo";
import { DotFlow } from "@/components/landing/dot-flow";
import { DotHero } from "@/components/landing/dot-hero";
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

const CARD = "group relative h-full rounded-xl border bg-card/50 p-6 transition-colors duration-300 ease-out hover:border-primary/60 sm:p-7";
const ICON_TILE = "grid size-11 place-items-center rounded-lg border border-primary/30 bg-primary/10 text-primary";

function SectionHead({ index, eyebrow, title }: { index: string; eyebrow: string; title: string }) {
  return (
    <Reveal>
      <p className="t-label text-primary">
        {index} / {eyebrow}
      </p>
      <h2 className="t-h1 mt-4 max-w-3xl">{title}</h2>
    </Reveal>
  );
}

function SectionBlock({ id, index, eyebrow, title, children }: { id?: string; index: string; eyebrow: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-14 border-t border-dotted">
      <div className="mx-auto w-full max-w-6xl px-4 py-14 sm:py-24">
        <SectionHead index={index} eyebrow={eyebrow} title={title} />
        <div className="mt-9 sm:mt-12">{children}</div>
      </div>
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
    <div className="landing">

      <DotHero>
        <h1 className="t-display max-w-4xl max-sm:text-[2.4rem]">Your loan, protected from liquidation.</h1>
        <p className="mt-5 max-w-[46ch] text-base text-muted-foreground sm:mt-6 sm:text-lg">
          Backstop repays part of your Aave loan when its health drops below your trigger, using spare USDC you keep in your own
          vault.
        </p>
        <div className="mt-7 flex justify-center gap-2.5">
          <Button asChild size="lg" className="max-sm:px-4">
            <Link href="/app">
              Protect my loan <ArrowRight aria-hidden />
            </Link>
          </Button>
          <Button asChild size="lg" variant="outline" className="bg-card/70 max-sm:px-4">
            <Link href="#how">See how it works</Link>
          </Button>
        </div>
        <p className="mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <ChainLogo chain="base" className="h-3.5" /> Base
          </span>
          <span className="inline-flex items-center gap-1.5">
            <ChainLogo chain="arbitrum" className="h-4" /> Arbitrum One
          </span>
          <span className="inline-flex items-center gap-1.5">
            <ChainLogo chain="near" className="h-3.5" /> NEAR
          </span>
        </p>
      </DotHero>

      <section aria-label="The terms" className="relative border-t border-dotted bg-background">
        <dl className="mx-auto grid w-full max-w-6xl grid-cols-2 lg:grid-cols-4">
          {FACTS.map((f, i) => (
            <div
              key={f.label}
              className={`flex flex-col-reverse justify-end gap-2 border-dotted px-4 py-7 sm:py-9 ${i % 2 ? "border-l" : ""} ${i > 1 ? "border-t lg:border-t-0" : ""} ${i === 2 ? "lg:border-l" : ""}`}
            >
              <dt className="text-sm text-muted-foreground">{f.label}</dt>
              <dd className="t-num text-2xl font-medium tracking-tight sm:text-4xl">{f.value}</dd>
            </div>
          ))}
        </dl>
        <ul className="t-label mx-auto flex w-full max-w-6xl flex-wrap gap-x-8 gap-y-2 border-t border-dotted px-4 py-4 text-muted-foreground">
          {TICKS.map((t) => (
            <li key={t}>
              <span className="mr-1.5 inline-block size-1.5 rounded-full bg-primary align-middle" aria-hidden />
              {t}
            </li>
          ))}
          {last ? (
            <li className="normal-case tracking-normal">
              Last rescue:{" "}
              <a href={last.links.baseRepayTx} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                {last.amountUsdc} USDC, health {last.hfBefore} → {last.hfAfter}
              </a>
            </li>
          ) : null}
        </ul>
      </section>

      <SectionBlock id="how" index="01" eyebrow="How it works" title="Three steps. Then it watches for you.">
        <ol className="grid gap-5 md:grid-cols-3">
          {STEPS.map((s, i) => (
            <li key={s.title}>
              <Reveal delay={i * 90} className="h-full">
                <div className={`${CARD} flex flex-col`}>
                  <div className="flex items-center justify-between">
                    <span className={ICON_TILE}>
                      <s.icon className="size-6" />
                    </span>
                    <span className="t-label text-muted-foreground">Step 0{i + 1}</span>
                  </div>
                  <h3 className="t-h3 mt-6">{s.title}</h3>
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

      <section aria-label="Where the money moves" className="border-t border-dotted">
        <div className="t-label mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 pt-6 text-muted-foreground">
          <span className="inline-flex items-center gap-2 text-foreground">
            <ChainLogo chain="near" className="h-4" /> Your vault
          </span>
          <span className="hidden text-primary sm:inline">Your spare USDC moves only when your loan needs it</span>
          <span className="inline-flex items-center gap-2 text-foreground">
            Your loan <ChainLogo chain="base" className="h-4" /> <ChainLogo chain="arbitrum" className="h-[1.125rem]" />
          </span>
        </div>
        <DotFlow />
      </section>

      <SectionBlock id="safety" index="02" eyebrow="Safety" title="Built so it can only repay your loan.">
        <div className="grid gap-5 md:grid-cols-3">
          {SAFETY.map((s, i) => (
            <Reveal key={s.title} delay={i * 90} className="h-full">
              <div className={`${CARD} ${i === 2 ? "border-primary/50 bg-primary/10" : ""}`}>
                <span className={ICON_TILE}>
                  <s.icon className="size-6" />
                </span>
                <h3 className="t-h3 mt-6">{s.title}</h3>
                <p className="mt-3 text-sm text-muted-foreground sm:text-base">{s.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
        <div className="mt-10">
          <p className="t-label text-muted-foreground">Under the hood</p>
          <ul className="mt-4 flex flex-wrap gap-2 text-sm">
            {UNDER_THE_HOOD.map((u) => (
              <li key={u.label}>
                <Link href={u.href} className="inline-flex items-center gap-2 rounded-full border px-3 py-1.5 transition-colors duration-200 hover:border-primary hover:text-primary">
                  {u.chain ? <ChainLogo chain={u.chain} className="h-4" /> : null}
                  {u.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </SectionBlock>

      {mainnetRows ? (
        <SectionBlock id="history" index="03" eyebrow="Rescue history" title="Every rescue, on the record.">
          <RescueHistory history={mainnetRows} chain={null} />
        </SectionBlock>
      ) : null}

      <section className="border-t border-dotted">
        <div className="mx-auto grid w-full max-w-6xl gap-9 px-4 py-14 sm:py-24 lg:grid-cols-[0.8fr_1.2fr] lg:gap-14">
          <div>
            <SectionHead index={mainnetRows ? "04" : "03"} eyebrow="FAQ" title="Questions." />
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
          </div>
          <Accordion type="single" collapsible className="rounded-xl border bg-card/50 px-5 sm:px-6">
            {FAQ.map((f) => (
              <AccordionItem key={f.q} value={f.q}>
                <AccordionTrigger>{f.q}</AccordionTrigger>
                <AccordionContent>{f.a}</AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </section>

      <section className="border-t border-dotted">
        <div className="mx-auto w-full max-w-6xl px-4 py-14 sm:py-24">
          <div className="relative rounded-2xl border border-primary/40 bg-card/50 px-6 py-12 text-center sm:px-12 sm:py-20">
            <h2 className="t-h1 mx-auto max-w-3xl">Put a backstop under your loan.</h2>
            <p className="mt-4 text-muted-foreground sm:text-lg">Set your limits once. Pause or withdraw any time.</p>
            <Button asChild size="lg" className="mt-8 w-full sm:w-auto">
              <Link href="/app">
                Protect my loan <ArrowRight aria-hidden />
              </Link>
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
