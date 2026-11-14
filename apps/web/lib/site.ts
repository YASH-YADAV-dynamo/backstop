export const SITE = {
  name: "Backstop",
  tagline: "Your loan, saved before liquidation.",
  description:
    "Backstop watches your DeFi loans and, when they get risky, pulls your own money from any chain to repay them, within limits you set.",
  repoUrl: process.env.NEXT_PUBLIC_REPO_URL || "#",
} as const;
