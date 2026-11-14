# Deploying on a single EC2 host

Two containers on one host, built and updated by hand: `web` (Next.js site, port 3000) and `bot` (rescue
bot, no inbound port). Postgres is hosted on Neon; there is no database container.

Backstop is an unaudited prototype. Vault creation is open to everyone unless `VAULT_ALLOWED_OWNERS` is set (then invite-only).

## Prerequisites

- EC2 instance (Linux, 2 GB RAM or more; the image build needs it) with Docker Engine and the Compose plugin
  (`docker compose version` must work).
- Security group: inbound 80 and 443 only (plus SSH from your own IP). The bot needs no inbound port.
  Port 3000 is published by compose, so do not open it in the security group; put nginx or an ALB in front
  for TLS (the containers serve plain HTTP).
- A Neon `DATABASE_URL`.
- The built policy wasm (below).

## 1. Get the code and the policy wasm

```bash
git clone <repo-url> backstop && cd backstop
```

The bot deploys new vaults from `contracts/policy/target/near/backstop_policy.wasm`. It is gitignored, so build
it on your Windows machine with `pnpm policy:build:wsl` and copy it to the same path on the host (for example
`scp`). `docker compose build` fails with a clear message if the file is missing. Its sha256 must equal
`POLICY_CODE_HASH` in both env files.

## 2. Create the two env files

```bash
cp .env.web.example .env.web
cp .env.bot.example .env.bot
chmod 600 .env.web .env.bot
```

Fill them in (every variable is documented in the examples and in `.env.example`).

- `.env.web`: `DATABASE_URL`, `VAULT_ALLOWED_OWNERS`, optional RPC URLs, and the `NEXT_PUBLIC_*` values. The
  `NEXT_PUBLIC_*` values are baked into the browser bundle at build time, so changing one needs a rebuild.
  Never put a private key in this file.
- `.env.bot`: `AGENT_ACCOUNT_ID`, `AGENT_PRIVATE_KEY`, `VAULT_DEPLOYER_PRIVATE_KEY`, `POLICY_CODE_HASH`,
  `FEE_ACCOUNT_ID`, `DATABASE_URL` and optional alert settings. Only the bot container reads it.

The files are separate so the web container cannot see the bot keys. Neither is committed or copied into an
image (`.dockerignore` excludes every `.env*` file except `.env.example`).

## 3. Start

```bash
docker compose --env-file .env.web up -d --build
```

`--env-file .env.web` supplies the build args; the runtime env comes from `env_file` in `docker-compose.yml`.
Both services restart automatically (`unless-stopped`).

## Update

```bash
git pull
# copy a new backstop_policy.wasm into place first if the contract changed
docker compose --env-file .env.web up -d --build
docker image prune -f
```

## Check health and logs

```bash
docker compose ps                  # web shows "healthy" once /icon.svg answers
curl -fsS http://localhost:3000/icon.svg | head -3
docker compose logs -f bot         # one line per pass; config errors print on startup and the bot exits
docker compose logs -f web
```

If the bot exits at startup, its message names the variable to fix in `.env.bot`.

## Secrets

- Keep `.env.web` and `.env.bot` at `chmod 600`, owned by the deploy user, and out of backups that leave the host.
- The bot account should hold only a small NEAR balance (see `.env.example`).
- Consider AWS Secrets Manager or SSM Parameter Store later, instead of files on disk.
