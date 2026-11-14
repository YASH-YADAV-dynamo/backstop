/**
 * Decorative animated vault for the "Create vault" step: the dial spins, the handle turns, USDC coins drop into
 * the slot, and a shield glows. Pure inline SVG + CSS (globals.css: vault-*), theme colors only, no assets.
 * Hidden from screen readers; all motion stops under prefers-reduced-motion.
 */
export function VaultArt({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 160 120" aria-hidden className={className} fill="none">
      {/* soft glow behind the vault */}
      <ellipse cx="80" cy="64" rx="62" ry="46" className="vault-glow" fill="var(--color-primary)" opacity="0.10" />

      {/* coins falling into the slot */}
      {[0, 1, 2].map((i) => (
        <g key={i} className="vault-coin" style={{ animationDelay: `${i * 0.9}s` }}>
          <circle cx="80" cy="6" r="6" fill="var(--color-primary)" />
          <text x="80" y="8.6" textAnchor="middle" fontSize="7" fontWeight="700" fill="var(--color-primary-foreground)">$</text>
        </g>
      ))}

      {/* vault body */}
      <rect x="34" y="22" width="92" height="84" rx="10" fill="var(--color-card)" stroke="var(--color-border)" strokeWidth="2" />
      <rect x="40" y="28" width="80" height="72" rx="7" fill="var(--color-muted)" stroke="var(--color-border)" strokeWidth="1.5" />
      {/* coin slot */}
      <rect x="68" y="24" width="24" height="3" rx="1.5" fill="var(--color-muted-foreground)" opacity="0.6" />
      {/* hinges */}
      <rect x="36" y="40" width="4" height="10" rx="1" fill="var(--color-muted-foreground)" opacity="0.5" />
      <rect x="36" y="78" width="4" height="10" rx="1" fill="var(--color-muted-foreground)" opacity="0.5" />

      {/* dial */}
      <circle cx="74" cy="64" r="20" fill="var(--color-card)" stroke="var(--color-border)" strokeWidth="2" />
      <g className="vault-dial">
        {Array.from({ length: 12 }, (_, i) => (
          <line key={i} x1="74" y1="47" x2="74" y2={i % 3 === 0 ? 51 : 49} stroke="var(--color-muted-foreground)" strokeWidth="1.2" transform={`rotate(${i * 30} 74 64)`} />
        ))}
        <circle cx="74" cy="64" r="9" fill="var(--color-muted)" stroke="var(--color-primary)" strokeWidth="2" />
        <line x1="74" y1="64" x2="74" y2="56" stroke="var(--color-primary)" strokeWidth="2.2" strokeLinecap="round" />
      </g>

      {/* handle */}
      <g className="vault-handle">
        <circle cx="106" cy="64" r="3" fill="var(--color-primary)" />
        <line x1="106" y1="64" x2="106" y2="54" stroke="var(--color-primary)" strokeWidth="2.5" strokeLinecap="round" />
        <line x1="106" y1="64" x2="114.7" y2="69" stroke="var(--color-primary)" strokeWidth="2.5" strokeLinecap="round" />
        <line x1="106" y1="64" x2="97.3" y2="69" stroke="var(--color-primary)" strokeWidth="2.5" strokeLinecap="round" />
      </g>

      {/* shield badge */}
      <g className="vault-shield">
        <path d="M128 78 l12 4.5 v8.5 c0 7 -5 11.5 -12 14 c-7 -2.5 -12 -7 -12 -14 v-8.5 z" fill="var(--color-safe)" stroke="var(--color-card)" strokeWidth="2" />
        <path d="M123 91 l3.5 3.5 l6.5 -7" stroke="var(--color-card)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </svg>
  );
}

/** Decorative wallet for the "Connect wallet" step: a wallet with a glowing clasp and a key badge. Same rules as VaultArt. */
export function WalletArt({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 160 120" aria-hidden className={className} fill="none">
      <ellipse cx="80" cy="64" rx="62" ry="46" className="vault-glow" fill="var(--color-primary)" opacity="0.10" />
      {/* card peeking out */}
      <rect x="50" y="26" width="56" height="30" rx="5" fill="var(--color-muted)" stroke="var(--color-border)" strokeWidth="1.5" />
      <rect x="57" y="33" width="18" height="4" rx="2" fill="var(--color-muted-foreground)" opacity="0.5" />
      {/* wallet body */}
      <rect x="34" y="40" width="92" height="62" rx="10" fill="var(--color-card)" stroke="var(--color-border)" strokeWidth="2" />
      <path d="M34 56 h92" stroke="var(--color-border)" strokeWidth="1.5" />
      {/* clasp */}
      <rect x="98" y="62" width="34" height="20" rx="10" fill="var(--color-muted)" stroke="var(--color-border)" strokeWidth="1.5" />
      <g className="vault-shield">
        <circle cx="110" cy="72" r="5" fill="var(--color-primary)" />
      </g>
      {/* key badge */}
      <g className="vault-shield">
        <circle cx="52" cy="92" r="13" fill="var(--color-safe)" stroke="var(--color-card)" strokeWidth="2" />
        <circle cx="48" cy="92" r="3.5" stroke="var(--color-card)" strokeWidth="2.2" />
        <path d="M51.5 92 h8 M57 92 v3.5" stroke="var(--color-card)" strokeWidth="2.2" strokeLinecap="round" />
      </g>
    </svg>
  );
}

/** Decorative coin stack for the "Add USDC" step: coins drop onto a stack. Same rules as VaultArt. */
export function CoinsArt({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 160 120" aria-hidden className={className} fill="none">
      <ellipse cx="80" cy="66" rx="62" ry="46" className="vault-glow" fill="var(--color-primary)" opacity="0.10" />
      {/* a coin dropping onto the stack */}
      {[0, 1].map((i) => (
        <g key={i} className="vault-coin" style={{ animationDelay: `${i * 1.35}s` }}>
          <ellipse cx="80" cy="22" rx="20" ry="7" fill="var(--color-primary)" />
        </g>
      ))}
      {/* the stack, bottom to top */}
      {[92, 78, 64].map((y) => (
        <g key={y}>
          <path d={`M54 ${y} v10 a26 9 0 0 0 52 0 v-10`} fill="var(--color-muted)" stroke="var(--color-border)" strokeWidth="1.5" />
          <ellipse cx="80" cy={y} rx="26" ry="9" fill="var(--color-card)" stroke="var(--color-border)" strokeWidth="1.5" />
        </g>
      ))}
      <ellipse cx="80" cy="64" rx="26" ry="9" fill="var(--color-primary)" opacity="0.9" />
      <text x="80" y="68" textAnchor="middle" fontSize="11" fontWeight="700" fill="var(--color-primary-foreground)">$</text>
    </svg>
  );
}
