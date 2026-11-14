"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Fades a block up as it scrolls into view. Content stays visible without JavaScript, when it is
 * already on screen at load, and with prefers-reduced-motion: only blocks below the fold are hidden first.
 */
export function Reveal({ children, className = "", delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (el.getBoundingClientRect().top < window.innerHeight) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setHidden(false);
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -10% 0px" },
    );
    const arm = requestAnimationFrame(() => {
      setHidden(true);
      io.observe(el);
    });
    return () => {
      cancelAnimationFrame(arm);
      io.disconnect();
    };
  }, []);

  return (
    <div
      ref={ref}
      className={`transition-[opacity,transform] duration-500 ease-out ${hidden ? "translate-y-2.5 opacity-0" : "opacity-100"} ${className}`}
      style={{ transitionDelay: hidden ? "0ms" : `${delay}ms` }}
    >
      {children}
    </div>
  );
}
