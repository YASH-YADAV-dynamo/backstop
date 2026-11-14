# Security model (v2 + vault factory in progress)

**Hackathon prototype, unaudited. Use tiny amounts.** Every claim below maps to code and a test in
[JUDGES.md](JUDGES.md). Nothing in this document has run on mainnet yet; "pending" means the
mainnet rehearsal has not happened.

## Hard rule

End users never type, paste, upload or export a private key or seed phrase. Every user action is a
transaction approved in the user's own wallet. No server or agent holds a key that can move user
funds outside the policy contract's limits.

## Pieces and money flow

```
owner's NEAR wallet --ft_transfer_call / any-chain 1Click deposit--> POLICY (NEAR, no access keys)
owner's NEAR wallet --create_policy (deposit, returned on close)--> FACTORY (NEAR, keyless) --creates--> POLICY
POLICY --withdraw (owner only, works while paused)--> owner
BOT (one NEAR account, agent of every vault) --fund_bridge(1Click-signed quote)--> POLICY --ft_transfer--> 1Click deposit address
1Click solver --Base USDC--> DERIVED ADDRESS (Base, controlled by the policy through v1.signer)
BOT --rescue(amount)--> POLICY --sign(repay tx hash)--> v1.signer
BOT --broadcast--> DERIVED ADDRESS --repay(USDC, amount, 2, borrower)--> Aave Pool
borrower = the user's own EVM address; the loan and collateral stay there
```

## Keys and what each can do

| Key | Where | Can | Cannot |
| --- | --- | --- | --- |
| Owner (NEAR wallet) | user's wallet only | Set limits / agent / borrower / bridge signer, pause, unpause, withdraw USDC and NEAR **to itself**. Every call except `pause` needs exactly 1 yoctoNEAR, so a browser-held function-call key cannot make them. | Call `rescue` / `fund_bridge` (unless it names itself agent). Redirect a withdrawal (no recipient parameter). |
| Borrower (EVM wallet) | user's wallet only | Everything on the loan. | Anything on the policy or the derived address. |
| Bot account (agent of every factory vault) | operator's bot host, in the host secret store | Its one full-access key acts as the bot NEAR account. On any vault that names the bot as agent it can call `rescue`, `fund_bridge`, `approve_pool`, inside that vault's limits. It also spends the bot account's own NEAR (kept at about 2 NEAR) and can delete the bot account. | Call owner methods (the vault checks the owner). Change agent, limits, owner or code. Withdraw from a vault. Attach a deposit to a vault (`rescue` and `fund_bridge` are not payable; `approve_pool` refuses an agent deposit). Pick the deposit address, recipient, refund account, or `to`, `value` or calldata of a Base tx. |
| Vault (policy account) keys | **none** | — | Nobody can sign as a vault or redeploy it. Only its code acts. |
| Factory account keys | **none** (keyless, immutable) | Create vaults: `create_policy`, for any caller who attaches the deposit. Claim a recorded refund (the refund goes to the caller). | Change its config, chains, fee, default agent or code. It has no setters. Nothing sweeps unclaimed refunds (R14). |
| Operator deployer key | operator machine, deploy time | Create and fund the factory, and operator-made policies. | Touch a live, finalized policy or the factory (no keys are left). **After the owner calls `close` on an operator-made policy, it can re-create the name (R11).** Factory vault names come from a counter, so they cannot be re-created. |
| 1Click quote key (ed25519) | 1Click | Sign quotes the policy will pay. | Make the policy pay more than the bridge limits, or route to anything but the policy's own addresses. |
| MPC threshold key | NEAR MPC network | Sign any hash the policy submits. | — (base trust assumption of Chain Signatures) |

The web app holds no secrets and never asks for a function-call key. The agent and the web both
refuse a policy account that has any access key (the agent accepts exactly one only with
`--allow-keyed-rehearsal`, see below).

**Why one bot account, not one key per vault.** Each vault names the bot account as its agent, not a
key. So a new self-serve vault is watched without an operator step, and rotating the bot's key does not
change any vault. The cost: one key reaches every vault that names the bot, so a bot compromise touches
all of them at once (see the worst cases and R17). Per vault, the vault accepts only the three agent
methods from the bot, so the bot can do nothing a per-vault key could not do. Per-vault keys added
on the same host would reach the same vaults, so the reach is the same; the difference is that the bot
account and its key list are extra things to protect.

## What the contract enforces

**It builds every Base transaction itself** (`contracts/policy/src/evm.rs`, `lib.rs` sign path):
EIP-1559, `chain_id` from state, `value = 0`, and only two shapes:
`repay(usdc_base, amount, 2, on_behalf_of)` to the Aave Pool, and `approve(aave_pool, daily_cap)` on
Base USDC. The agent supplies amount, nonce and fees; fees and gas are capped. The MPC signature is
ecrecovered against `base_address` and normalised to low-s before it is returned.

**It checks every bridge** (`contracts/policy/src/bridge.rs`): ed25519 signature of 1Click over the
exact quote bytes; unknown fields rejected; `dry = false`; `EXACT_INPUT`;
origin = NEAR USDC; destination = Base USDC; recipient = `base_address`; refund = the policy;
deposit address is a NEAR implicit account; loss at most 2%; quote fresh and its deposit address not
about to expire; each quote usable once.

**Limits** (`limits.rs`): pause; `max_per_rescue`; UTC-day `daily_cap`, tracked separately for
rescues and for bridges; cooldowns (never zero); `max_fee_per_gas` and `max_gas_limit`;
`approve_pool` at most once per hour. Budgets are reserved before the cross-contract call and rolled
back only when the call failed and nothing newer superseded it. These limits are per vault: a bot
that serves N vaults has N separate budgets.

**Withdrawals** go only to the owner, work while paused and before activation, and keep the NEAR
needed for storage. Deposits: any sender may deposit USDC (plain `ft_transfer` or
`ft_transfer_call`); there is no ledger, the token balance is the balance. Other tokens sent with
`ft_transfer_call` are refunded.

**Activation** computes the derived address on-chain from `v1.signer.derived_public_key`; it is
never passed in.

**The factory** (`contracts/factory`, in progress; not deployed) creates each vault in one
transaction with no `AddKey`, deploys the embedded policy wasm, and calls `new` with the owner taken
from the caller. The caller cannot pick the owner, agent, name or code. The vault's name is
`<chain>-<n>.<factory>`, where `n` comes from a counter that is seeded with the factory's init block
height and never reused. `activate` and the USDC storage registration run in the factory's callback,
not in the create batch, because a failed `activate` must not trigger a refund of NEAR the factory no
longer holds. A failed create refunds the whole deposit to the caller, or records a refund the caller
claims with `claim_refund`.

## Any-chain deposits (fund from any chain)

`/app` → Deposit → "From another chain" requests a 1Click quote from our server route with a fixed
recipient (the policy), destination (NEAR USDC), `EXACT_INPUT` and refund to the user's origin-chain
address. The client cannot set those fields. The server verifies 1Click's signature and that every
signed field matches the request, and the browser checks them again before it shows a deposit
address (including the signature, with WebCrypto Ed25519, where the browser supports it). The route refuses a policy that fails verification or is not registered on NEAR
USDC. If the user sends the wrong token, chain or amount, or misses the deadline, 1Click refunds to
the refund address or the funds can be lost: the page says so. Aurora Intents Connect was evaluated
and not used: it cannot target NEAR yet.

## Worst cases

| Compromised | Worst outcome | Response |
| --- | --- | --- |
| Bot account key or host (one key, every vault that names the bot as agent) | Per vault, as before: bridges up to that vault's `daily_cap` per UTC day to its derived address (where it can only repay the borrower's debt), repays early, loses up to 2% of each bridge to 1Click fees plus the service fee (R13), burns capped gas, wastes the day's budget. Across vaults the amounts add up: the sum of their daily caps per day, until each owner acts. Not theft of principal. The bot's own NEAR (about 2) can be spent on gas. | Operator: delete the compromised key and add a new one on the bot account (vaults keep the same agent account, so no vault changes), and stop the host. Owner of a vault: `pause()`, then `set_agent`. There is no global pause: each owner must act on their own vault. |
| Website | Shows false data; proposes harmful owner transactions. Each needs an explicit wallet approval that shows contract, method and arguments; no session key exists. | Read the wallet prompt. |
| 1Click | With the bot key too: up to `daily_cap` per day to an attacker deposit address until paused. Alone: funds in flight can be withheld. | `pause()`; `set_bridge_signer` after a key rotation. |
| A NEAR or Base RPC | Rescue when not needed, or no rescue. Cannot change what the policy signs or pays. | Built-in fallback RPC lists. |
| MPC network | Can sign anything for the derived address: transient USDC and gas ETH there. The loan is not there. | Keep that balance small. |
| Operator | Same as bot + website. Can stop running the bot, and can set the factory's fee account and chain list at deploy time (each fixed after deploy). | Withdraw; run your own agent with `set_agent`. |

## First deploy: keyed rehearsal, then keyless

A keyless contract cannot be fixed. So the first mainnet policy is created with
`deploy-policy --rehearsal`, which adds one temporary full-access key. We run activate, a deposit,
a withdraw, `fund_bridge`, `approve_pool` and a rescue, plus negative checks (a second `new`, a
stranger calling callbacks, a deposit attached to `rescue`). If something fails, `--redeploy`
replaces the code. Then `deploy-policy --finalize` deletes the key and checks the key list is
empty. Until finalized, the key holder bypasses every limit: do not fund a rehearsal policy beyond
test amounts.

The factory follows the same rule once it is written: it may first be deployed with a rehearsal key
that is deleted by `--finalize`, and the web refuses any factory that has keys. The factory deploy
script is planned, not yet written. **Pending:** no factory has been deployed and no vault has been
created on mainnet.

## Security review (2026-11-13, internal, not an audit)

No Critical or High finding for the policy contract. The vault factory and the multi-vault bot
service were added on 2026-11-14 and have **not** been reviewed yet.

| # | Finding | Status |
| --- | --- | --- |
| F1 | Fixed gas for `ft_transfer` in `withdraw`, `derived_public_key`, and the bridge batch could lock funds in an immutable contract. | **Fixed**: these calls get all unused gas (`function_call_weight`); withdraw callback 10 TGas. |
| F2 | First mainnet run on an unfixable account. | **Fixed in process**: keyed rehearsal + finalize (above). |
| F3 | No sweep: USDC and ETH at the derived address leave only as repayments. | **Open (R9)**. Workaround: the owner sets itself as agent and calls `rescue`. Keep the derived balance small. |
| F4 | A late MPC response after a rollback could make a valid signature public beyond `daily_cap`. Money still goes only to the borrower's debt, bounded by the bridge budget. | Accepted; the bridge budget is the hard cap. |
| F5 | Each bridge spends ~0.00125 NEAR of the policy's balance; a stolen bot key can drain spare NEAR. | Accepted; withdraw is unaffected; top up NEAR. |
| F6 | Only USDC can be withdrawn; other NEP-141 tokens sent by plain `ft_transfer` are stuck. | Accepted; do not send other tokens. |
| F7 | Limit changes take effect at once (no timelock). After lowering `daily_cap`, the Base allowance stays at the old value until the next `approve_pool` (spender is the Aave Pool only). | Accepted; timelock is post-hackathon. |
| F8 | A failed broadcast lost a signed repay or approve. | **Fixed**: broadcasts retry in-pass; a signed repay stays resumable and is retried every pass while its nonce is current; a signed approve is re-sent instead of waiting out the hour. |
| F9 | Config is checked once at agent startup. | Accepted; the contract builds and checks everything. |
| F10 | `#[init]` / `#[private]` / non-payable guards are only unit-tested at source level. | Covered by the rehearsal's negative checks. |

## Residual risks

- **R1 MPC trust.** Whoever controls `v1.signer`'s key controls the derived address.
- **R2 1Click custody in flight.** Up to one bridge is in 1Click's hands until delivery or refund.
- **R3 Immutable policy vs changing APIs.** If 1Click changes its signed format or Aave its Pool,
  bridging or repaying stops; funds stay withdrawable. Migration = withdraw, create a new policy.
- **R4 Stolen bot key.** See worst cases; not theft of principal. Bounded per vault by that vault's
  limits; across vaults the bounds add up until each owner pauses or changes the agent (R17).
- **R5 The trigger is not enforced on-chain.** NEAR cannot see the Base health factor.
- **R6 Wallet adapter supply chain.** NEAR Connect loads wallet scripts at runtime; the wallet's
  own confirmation screen is the control.
- **R7 Speed.** A rescue with a bridge takes about a minute; USDC already at the derived address
  removes the bridge from the critical path.
- **R8 Held NEAR.** About 2.8 NEAR of code storage sits in each policy while it exists. `close`
  (owner only, paused, 1 h after the last sign or bridge request, USDC withdrawn) deletes the
  policy and sends all its NEAR to the owner; there is no beneficiary parameter. For factory vaults
  the owner's deposit comes back this way, less about 0.007 NEAR that is never returned.
- **R9 No sweep** (F3).
- **R10 Unaudited, built in a day.**
- **R11 Name re-creation after `close`** (operator-made policies only). A policy made by the operator
  is `<name>.<deployer>`. After `close` only the deployer account can create that name again, with any
  code, and that code would control the same derived Base address and any USDC that later arrives under
  the old name. Funds inside a live policy are not affected. Leftovers (Base USDC/ETH that cannot be
  swept, a late 1Click refund) are exposed. Close only after emptying the Base address; for third-party
  users, use the factory (R14) rather than creating the policy under the operator's account.
- **R12 `close` can stop working.** Each accepted quote adds about 73 B of state that is never
  pruned; after roughly 120 lifetime bridges `DeleteAccount` exceeds NEAR's 10 KB limit and fails.
  Nothing is lost (funds stay withdrawable), the NEAR deposit just stays.
- **R13 Service fee outside the caps.** The fee (default 0.10%, hard cap 0.50%, fixed at creation) is
  charged on top of `amount_in` and does not count against `daily_cap` or `max_per_rescue`. A
  compromised or greedy agent can therefore move `daily_cap` plus the fee per day. If the operator who
  runs the agent is also the fee recipient, it earns up to 0.5% of `daily_cap` per day by bridging
  without need; the owner can lower the cap or pause. The fee is not refunded if 1Click refunds.
  Factory vaults take their fee rate and fee account from the factory config, so every factory vault
  pays the same fee account; the rate is fixed at creation and capped at 0.50%.
- **R14 The factory is keyless and immutable (planned, not deployed).** A bug in the factory cannot be
  fixed. Its chain allow-list is fixed at `new`, so adding a chain means a new factory and users move
  their vaults (withdraw, then create). Unclaimed refunds stay in the factory until the owner calls
  `claim_refund`; no method sweeps them, so an owner who never claims leaves that NEAR there. A refund
  is recorded when the factory cannot pay it at once (`refund_pending`), and only the owner's account
  can claim it. The factory's policy code is the embedded wasm; `policy_code_hash` pins it.
- **R15 Names and privacy (factory).** A vault's name is `<chain>-<n>.<factory>`: the chain and a
  creation counter. The name reveals how many vaults were created, and the loan address the user
  supplies is in the create transaction and in the vault's state. Both are public on-chain. Names are
  never chosen by the caller, so they cannot be front-run, collide, or reveal an owner's account name.
- **R16 The borrower address is not proven.** The factory does not check that the owner controls the
  loan address (no signature is asked for). Anyone can repay any Aave loan on its owner's behalf, so
  a vault named at someone else's loan repays that loan with the owner's USDC. The web checks that the
  loan has USDC variable debt on the chain, not who owns it.
- **R17 One bot for every vault (availability and shared blast radius).** A bot that is down or out of
  NEAR stops rescues for every vault at once; no funds move in that case. A compromised bot key
  reaches every vault that names the bot (see worst cases). There is no global pause. The planned
  mitigations are: keep the bot account at about 2 NEAR, keep its key in the operator's secret store,
  and alerts (`ALERT_WEBHOOK_URL`: rescue done or failed, bot NEAR low, a vault refused, RPC failing).
  Alerts are planned and not built.

## Unverified until the mainnet rehearsal

- 1Click accepts a deposit made by a contract's cross-contract `ft_transfer`, and refunds to a
  contract account (U1, U2).
- 1Click delivers any-chain deposits to the policy by plain `ft_transfer` (U12).
- Gas use of `fund_bridge`, `activate`, `withdraw` on mainnet (U3; mitigated by F1).
- NEAR Connect "Ethereum Wallets" accounts can sign owner calls with 1 yoctoNEAR (U11). The web
  lists that wallet; the docs claim nothing until tested.
- Factory `create_policy` on mainnet: the 300 TGas budget, the refund path when `activate` or the USDC
  storage registration fails, the order of the runtime refund and the callback in one block (U13),
  and `claim_refund` (pending).
- One bot account, with a full-access key, serving several vaults in one pass with no nonce collisions
  (the multi-vault service is in progress, pending).

## Web

No secrets in the web process; `NEXT_PUBLIC_*` values are only ids and URLs. Enforced headers
(`apps/web/next.config.ts`): `X-Frame-Options: DENY`, `nosniff`, strict referrer, Permissions-Policy,
HSTS. The CSP (with `frame-ancestors 'none'`) ships as **Report-Only** until every wallet has been
tested against it. It allows `'unsafe-inline'` scripts and `https:` connections because NEAR Connect
runs wallet adapters as inline scripts in sandboxed iframes; nonce-based CSP is future work. Addresses are never truncated in
a review dialog. One click = at most one wallet prompt. The planned create-vault flow reads the factory
and refuses to create a vault unless the factory has no keys and its chains, pool, USDC and fee match
the site's registry (pending).
