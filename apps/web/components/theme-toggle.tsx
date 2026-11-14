"use client";

import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Flips the theme class on <html> and remembers the choice. */
export function ThemeToggle() {
  function toggle() {
    const root = document.documentElement;
    const next = root.classList.contains("dark") ? "light" : "dark";
    root.classList.remove("light", "dark");
    root.classList.add(next);
    try {
      localStorage.setItem("theme", next);
    } catch {
      // storage blocked: the choice lasts for this page view only
    }
  }
  return (
    <Button variant="ghost" size="icon" onClick={toggle} aria-label="Toggle light or dark theme">
      <Sun className="hidden dark:block" aria-hidden />
      <Moon className="block dark:hidden" aria-hidden />
    </Button>
  );
}

/** Runs before paint so the page never flashes the wrong theme. Dark unless the visitor chose light. */
export const themeScript = `(function(){try{var t=localStorage.getItem("theme");}catch(e){}var d=t?t==="dark":true;document.documentElement.classList.add(d?"dark":"light");})();`;
