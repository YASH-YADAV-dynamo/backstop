export function ShieldMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <path
        d="M16 3 5 7v8c0 7 4.7 12.1 11 14 6.3-1.9 11-7 11-14V7L16 3Z"
        fill="currentColor"
        opacity="0.15"
      />
      <path
        d="M16 3 5 7v8c0 7 4.7 12.1 11 14 6.3-1.9 11-7 11-14V7L16 3Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="m11 16 3.5 3.5L21 13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
