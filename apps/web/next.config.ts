import { loadEnvConfig } from "@next/env";
import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

// One .env for the whole monorepo: load the repo-root .env (and .env.local) as well.
loadEnvConfig(fileURLToPath(new URL("../..", import.meta.url)));

/**
 * Security headers. The CSP ships as Report-Only until every listed
 * wallet has been tested against it (T2.4); the other headers are enforced. `'unsafe-inline'` and
 * `https:` connections are needed because NEAR Connect runs wallet adapters as inline scripts in
 * sandboxed iframes that talk to hosts we cannot enumerate.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https: wss:",
  "frame-src 'self' https:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy-Report-Only", value: csp },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  // Self-contained server for the Docker image (apps/web/Dockerfile). Traced from the repo root so
  // the workspace packages are included.
  output: "standalone",
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  // Workspace packages ship TypeScript source.
  transpilePackages: [
    "@backstop/config",
    "@backstop/core",
    "@backstop/lending-aave",
    "@backstop/chains",
    "@backstop/db",
    "@backstop/receipts",
  ],
  poweredByHeader: false,
  // The packages use NodeNext-style imports ("./risk.js" -> risk.ts). Webpack maps those
  // (Turbopack has no extensionAlias yet, so dev and build run with --webpack).
  webpack(config: { resolve: { extensionAlias?: Record<string, string[]> } }) {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};

export default nextConfig;
