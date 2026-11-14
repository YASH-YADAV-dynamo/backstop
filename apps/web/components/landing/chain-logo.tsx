import Image from "next/image";

/**
 * Official network logos, served unmodified from /public/chains (sources listed in public/chains/README.md).
 * NEAR's icon is single-color, so the black file shows on the light theme and the white file on the dark one.
 */
const LOGOS = {
  base: { name: "Base", width: 1280, height: 1280, src: "/chains/base.svg" },
  arbitrum: { name: "Arbitrum One", width: 1080, height: 1218.5, src: "/chains/arbitrum-one.svg" },
  near: { name: "NEAR", width: 351, height: 351, src: "/chains/near.svg" },
} as const;

export type ChainLogoKey = keyof typeof LOGOS;

export const chainName = (chain: ChainLogoKey): string => LOGOS[chain].name;

/** A decorative logo: always put the network name next to it as text. `className` sets the height. */
export function ChainLogo({ chain, className = "h-5" }: { chain: ChainLogoKey; className?: string }) {
  const logo = LOGOS[chain];
  const cls = `w-auto shrink-0 ${className}`;
  if (chain !== "near") return <Image src={logo.src} alt="" width={logo.width} height={logo.height} unoptimized className={cls} />;
  return (
    <>
      <Image src={logo.src} alt="" width={logo.width} height={logo.height} unoptimized className={`${cls} dark:hidden`} />
      <Image src="/chains/near-white.svg" alt="" width={logo.width} height={logo.height} unoptimized className={`${cls} hidden dark:block`} />
    </>
  );
}

/** Logo plus name in a quiet pill. */
export function ChainChip({ chain, className = "" }: { chain: ChainLogoKey; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 whitespace-nowrap rounded-full border bg-card/60 px-3 py-1.5 text-sm font-medium ${className}`}>
      <ChainLogo chain={chain} className="h-4" />
      {LOGOS[chain].name}
    </span>
  );
}
