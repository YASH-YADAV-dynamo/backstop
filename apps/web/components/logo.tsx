/**
 * The Backstop mark: a line that falls, is caught by a floor and bounces back up.
 * One 2.5-unit round stroke on a 32 grid, so it stays legible at 16px. Inherits the text color.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} fill="none" stroke="currentColor" strokeWidth={2.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5.5 6.5 14.5 20 26.5 8" />
      <path d="M8 25.5h16" />
    </svg>
  );
}

/** Mark plus the lowercase wordmark. */
export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <LogoMark className="size-6 text-primary" />
      <span className="text-[1.0625rem] font-semibold lowercase leading-none tracking-[-0.02em]">backstop</span>
    </span>
  );
}
