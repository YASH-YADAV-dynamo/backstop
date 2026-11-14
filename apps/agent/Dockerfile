# Backstop bot service (many vaults). Build context MUST be the repo root:
#   docker build -f apps/agent/Dockerfile -t backstop-bot .
# The policy wasm is gitignored; build it first with `pnpm policy:build:wsl` (see docs/DEPLOY-EC2.md).
FROM node:22-alpine
RUN corepack enable
WORKDIR /app

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
# The agent runs TypeScript source through tsx (a root devDependency), so dev dependencies stay.
RUN pnpm install --frozen-lockfile --filter @backstop/agent...

COPY tsconfig.base.json ./
COPY packages packages
COPY apps/agent apps/agent

# Wildcard so a missing file reaches the check below instead of failing with a generic COPY error.
COPY contracts/policy/target/near/backstop_policy.wasm* /opt/backstop/
RUN test -s /opt/backstop/backstop_policy.wasm || { \
      echo "ERROR: contracts/policy/target/near/backstop_policy.wasm is missing. Run 'pnpm policy:build:wsl' on the build host first, then rebuild." >&2; \
      exit 1; }

RUN addgroup -S -g 1001 app && adduser -S -u 1001 -G app app
USER app
ENV NODE_ENV=production POLICY_WASM_PATH=/opt/backstop/backstop_policy.wasm
CMD ["pnpm", "--filter", "@backstop/agent", "start"]
