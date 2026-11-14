# Backstop website (Next.js standalone). Build context MUST be the repo root:
#   docker build -f apps/web/Dockerfile -t backstop-web .
# NEXT_PUBLIC_* values are inlined at build time, so pass them as build args (see docker-compose.yml).
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY apps/agent/package.json apps/agent/
COPY scripts/package.json scripts/
COPY packages/chains/package.json packages/chains/
COPY packages/config/package.json packages/config/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/mover/package.json packages/mover/
COPY packages/receipts/package.json packages/receipts/
COPY packages/signer/package.json packages/signer/
COPY packages/adapters/lending-aave/package.json packages/adapters/lending-aave/
RUN pnpm install --frozen-lockfile --filter @backstop/web...

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/web apps/web
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_REPO_URL
ARG NEXT_PUBLIC_AGENT_ACCOUNT_ID
ARG NEXT_PUBLIC_POLICY_CODE_HASH
ARG NEXT_PUBLIC_POLICY_CODE_BYTES
ARG NEXT_PUBLIC_VAULT_DEPLOYER_PK
ARG NEXT_PUBLIC_WC_PROJECT_ID
ARG NEXT_PUBLIC_GET_NEAR_ENABLED
ARG NEXT_PUBLIC_INVITE_CONTACT
ARG NEXT_PUBLIC_POLICY_CONTRACT_ID
ARG NEXT_PUBLIC_FACTORY_ID
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_PUBLIC_REPO_URL=$NEXT_PUBLIC_REPO_URL \
    NEXT_PUBLIC_AGENT_ACCOUNT_ID=$NEXT_PUBLIC_AGENT_ACCOUNT_ID \
    NEXT_PUBLIC_POLICY_CODE_HASH=$NEXT_PUBLIC_POLICY_CODE_HASH \
    NEXT_PUBLIC_POLICY_CODE_BYTES=$NEXT_PUBLIC_POLICY_CODE_BYTES \
    NEXT_PUBLIC_VAULT_DEPLOYER_PK=$NEXT_PUBLIC_VAULT_DEPLOYER_PK \
    NEXT_PUBLIC_WC_PROJECT_ID=$NEXT_PUBLIC_WC_PROJECT_ID \
    NEXT_PUBLIC_GET_NEAR_ENABLED=$NEXT_PUBLIC_GET_NEAR_ENABLED \
    NEXT_PUBLIC_INVITE_CONTACT=$NEXT_PUBLIC_INVITE_CONTACT \
    NEXT_PUBLIC_POLICY_CONTRACT_ID=$NEXT_PUBLIC_POLICY_CONTRACT_ID \
    NEXT_PUBLIC_FACTORY_ID=$NEXT_PUBLIC_FACTORY_ID \
    NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @backstop/web build

FROM node:22-alpine AS runner
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
RUN addgroup -S -g 1001 app && adduser -S -u 1001 -G app app
# Standalone server (traced from the repo root, so it lives at apps/web/server.js), static assets, public files.
COPY --from=build --chown=app:app /repo/apps/web/.next/standalone ./
COPY --from=build --chown=app:app /repo/apps/web/.next/static apps/web/.next/static
COPY --from=build --chown=app:app /repo/apps/web/public apps/web/public
# The /docs pages read markdown from <repo>/docs/site at runtime.
COPY --chown=app:app docs/site docs/site
USER app
WORKDIR /app/apps/web
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO /dev/null http://127.0.0.1:3000/icon.svg || exit 1
CMD ["node", "server.js"]
