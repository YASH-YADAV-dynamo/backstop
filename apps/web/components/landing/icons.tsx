import type { ReactNode } from "react";

/**
 * Backstop's own icon set for the landing page. One grid (24), one stroke (1.5, round), and one
 * accent rule: the part of the icon that carries the meaning gets a soft tint of the current color.
 */
function Icon({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      {children}
    </svg>
  );
}

const TINT = { fill: "currentColor", fillOpacity: 0.18 } as const;
type IconProps = { className?: string };

/** A vault door: your spare USDC, locked to you. */
export function VaultIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <rect x="3" y="3.5" width="18" height="15" rx="3" />
      <circle cx="12" cy="11" r="3.25" {...TINT} />
      <path d="M12 6.25v1.5M12 14.25v1.5M7.25 11h1.5M15.25 11h1.5M7 18.5v2M17 18.5v2" />
    </Icon>
  );
}

/** A health line inside a lens: the loan is checked all the time. */
export function WatchIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <circle cx="12" cy="12" r="9" {...TINT} />
      <path d="M6 12.5h2.75l1.5-3.75 3 7 1.5-3.25H18" />
    </Icon>
  );
}

/** A receipt with a tick: part of the loan repaid, with proof. */
export function RepayIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M5.5 3h13v18l-3.25-2L12 21l-3.25-2L5.5 21V3Z" {...TINT} />
      <path d="m8.75 10.75 2.25 2.25 4.25-4.5" />
    </Icon>
  );
}

/** A struck-through key: the rescue wallet has no private key. */
export function NoKeyIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <circle cx="8" cy="15.5" r="4" {...TINT} />
      <path d="m11 12.75 2-2M15.25 8.5 19.5 4.25M16.5 7.25l2.25 2.25M3.5 3.5l17 17" />
    </Icon>
  );
}

/** Three sliders: the limits you set. */
export function LimitsIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M4 6h8M17 6h3M4 12h2.5M11.5 12H20M4 18h9.5M18.5 18H20" />
      <circle cx="14.5" cy="6" r="2.25" {...TINT} />
      <circle cx="9" cy="12" r="2.25" {...TINT} />
      <circle cx="16" cy="18" r="2.25" {...TINT} />
    </Icon>
  );
}

/** A shield around a small core: even the worst case stays contained. */
export function ContainedIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M12 2.75 4.5 5.5v6.25c0 4.6 3.1 8 7.5 9.5 4.4-1.5 7.5-4.9 7.5-9.5V5.5L12 2.75Z" />
      <circle cx="12" cy="11.5" r="2.75" {...TINT} />
    </Icon>
  );
}
