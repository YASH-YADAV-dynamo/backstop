---
title: Quickstart
description: Use Backstop with your wallets, or run the code, the agent and the operator scripts yourself.
order: 6
---

# Quickstart

> Beta. The smart contracts are not yet audited. Read [Risks and limits](/docs/risks-and-limits) before you deposit.

## Using the app

You need a NEAR wallet (HOT, Meteor, MyNearWallet, Intear, ...) and an Aave v3 loan with USDC debt on
Base or Arbitrum One (native USDC; USDC.e is not supported). Opening a vault holds about 3 NEAR, which
you get back when you close it; the app shows the exact amount first.

1. **Connect your NEAR wallet** at `/app`. Sign-in adds no key. The wallet owns your vault.
2. **Find your loan.** Paste the address that holds your Aave loan (the app only reads it) or connect an
   EVM wallet to fill it in.
3. **Pick your limits.** Choose how early Backstop steps in and how much it may repay at a time and per
   day, or adjust each limit.
4. **Add USDC** to your vault from your NEAR wallet or from another chain, then send a little ETH on
   your loan chain (about 0.0003) so repayments can pay network fees.
5. **Manage.** Change limits, pause (one click), resume, withdraw USDC or NEAR, or close the vault to get
   its NEAR back (pause first, wait an hour after the last rescue, withdraw the USDC, and empty the
   rescue wallet on the loan chain). Every action shows a review screen with the exact contract, method
   and amounts, then your wallet asks you to approve.

Until the vault factory is live on mainnet, the operator creates your vault for you (see "Create a
policy (operator)" below); everything after that is the same. Without an operator 1Click key, bridging
from another chain adds a 0.25% 1Click fee.

## As a developer

```bash
pnpm install
cp .env.example .env               # every variable is documented there; none is a user key
pnpm test                          # all TypeScript tests
pnpm contract:test                 # policy contract unit tests (cargo)
pnpm contract:build                # wasm32-unknown-unknown release build
pnpm --filter @backstop/web dev    # http://localhost:3000
```

### Run the agent

`.env`: `POLICY_CONTRACT_ID`; for live runs also `AGENT_ACCOUNT_ID` and `AGENT_PRIVATE_KEY`
(a function-call key limited to `rescue`, `fund_bridge`, `approve_pool` on the policy).

```bash
pnpm demo --dry-run          # read HF, decide, print what it would do; sends nothing, needs no keys
pnpm demo                    # one live pass
pnpm demo --trigger 3.0      # demo override of the trigger (the contract's limits still apply)
pnpm --filter @backstop/agent start --interval 30   # keep watching
```

The agent refuses to run unless the policy is keyless, activated, and its config and derived
address match what it expects.

### Create a policy (operator)

`.env`: `DEPLOYER_ACCOUNT_ID`, `DEPLOYER_PRIVATE_KEY` (the operator account that pays; never a
user's key). Every command is a dry run that prints the full transaction until you add `--send`.

```bash
# First mainnet policy: a rehearsal with one temporary key
pnpm --filter @backstop/scripts deploy-policy --name alice --owner alice.near --borrower 0x... --rehearsal
pnpm demo --allow-keyed-rehearsal           # test every path on the rehearsal policy
pnpm --filter @backstop/scripts deploy-policy --redeploy alice.<deployer>.near --send   # only if a fix is needed
pnpm --filter @backstop/scripts deploy-policy --finalize alice.<deployer>.near --send   # delete the key for good

# Later policies: keyless from the start
pnpm --filter @backstop/scripts deploy-policy --name bob --owner bob.near --borrower 0x... --send
```

Optional fee: set `FEE_ACCOUNT_ID` (a NEAR account you control; it receives NEAR USDC) and
`FEE_BPS` (default 10 = 0.10%, contract cap 50) in `.env`. Without `FEE_ACCOUNT_ID` the policy charges
nothing. The fee is fixed when the policy is created.

The deployer needs about 2.95 NEAR per policy (about 2.8 NEAR of it is code storage, which the owner gets
back with `close`). The script prints the exact amount and the near-cli-rs command that gives the agent its
limited key.

### Owner commands without the web

```bash
pnpm --filter @backstop/scripts policy status
pnpm --filter @backstop/scripts policy print pause            # prints a near-cli-rs command for the owner
pnpm --filter @backstop/scripts policy print withdraw --usdc 1
pnpm --filter @backstop/scripts aave-setup status --address 0x...
```

The scripts never sign as the owner: they print the command for the owner to run in their own wallet
or CLI.
