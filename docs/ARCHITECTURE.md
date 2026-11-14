# Architecture (v2 + vault factory in progress)

Backstop keeps a user's rescue USDC in a **keyless NEAR policy contract** (a vault), watches the user's Aave
v3 loan on Base, and when the health factor falls below the trigger, bridges USDC to a Base address
the policy controls (Chain Signatures) and repays the loan **on behalf of** the user's own address.
The policy builds and checks every transaction it pays or signs. Security: [SECURITY.md](SECURITY.md). Claims → tests: [JUDGES.md](JUDGES.md).

## Diagrams

### The whole system

```mermaid
flowchart LR
  subgraph YOU["You: your own wallets, no key ever shared"]
    NW["NEAR wallet<br/>OWNER of the policy<br/>sets limits, pauses, withdraws"]
    EW["EVM wallet<br/>holds your Aave loan<br/>(the borrower address)"]
  end
  ANY["Spare USDC on any chain"]
  subgraph NEAR["NEAR mainnet"]
    FAC["VAULT FACTORY (keyless, immutable; in progress)<br/>creates one vault per user<br/>chain allow-list fixed at init"]
    POL["POLICY CONTRACT (Rust, no access keys)<br/>holds your rescue USDC<br/>enforces your limits<br/>verifies 1Click quote signatures<br/>builds the only 2 EVM txs it signs"]
    MPC["v1.signer<br/>Chain Signatures MPC"]
  end
  ONE["NEAR Intents 1Click<br/>NEAR USDC to loan-chain USDC"]
  AG["BOT ACCOUNT (off-chain worker)<br/>one NEAR account, full-access key in the operator's secret store<br/>agent of every vault: rescue, fund_bridge, approve_pool only"]
  subgraph EVM["Loan chain: Base or Arbitrum"]
    DER["Derived address<br/>NO private key exists<br/>USDC to repay + gas ETH"]
    AAVE["Aave v3 Pool"]
    LOAN["Your loan<br/>collateral + USDC debt"]
  end
  NW -->|"create your vault: deposit returned on close<br/>(signed in your wallet)"| FAC
  FAC -->|"creates, deploys and initialises the vault<br/>(no access keys)"| POL
  NW -->|"deposit, set limits, pause, withdraw<br/>(signed in your wallet)"| POL
  ANY -->|"any-chain deposit"| ONE
  ONE -->|"NEAR USDC lands in your policy"| POL
  AG -->|"1. health factor every 30 s"| AAVE
  AG -->|"2. approve_pool, fund_bridge, rescue"| POL
  POL -->|"3. pays 1Click deposit address<br/>(only for a quote 1Click signed)"| ONE
  ONE -->|"4. delivers USDC"| DER
  POL -->|"5. sign(hash of the repay tx)"| MPC
  MPC -->|"6. signature, ecrecover must equal derived address"| POL
  POL -->|"7. signed tx"| AG
  AG -->|"8. broadcast"| DER
  DER -->|"9. repay(USDC, amount, 2, your address)"| AAVE
  AAVE -->|"debt goes down, HF goes up"| LOAN
  EW -.->|"owns"| LOAN
```

Numbers 1-9 follow one rescue. Trust zones: the policy contract (limits, signing) and the NEAR MPC signer are on-chain; the bot is a thin, replaceable worker whose one account is the agent of every vault and can call only three methods on each; the derived address has no private key.

### One rescue, in order

```mermaid
sequenceDiagram
    autonumber
    participant AG as Agent
    participant AV as Aave v3 Pool (loan chain)
    participant P as Policy contract (NEAR)
    participant X as 1Click (NEAR Intents)
    participant M as v1.signer (MPC)
    participant D as Derived address (loan chain)

    AG->>AV: getUserAccountData(borrower)
    AV-->>AG: collateral, debt, liquidation threshold, HF
    Note over AG: HF below your trigger: repay = min(amount to reach target HF, max_per_rescue, remaining today, your USDC debt)
    opt allowance too low
        AG->>P: approve_pool(nonce, fees, gas)
        P->>M: sign(approve(Aave Pool, daily_cap))
        M-->>P: signature
        P-->>AG: signed tx, AG broadcasts it from D
    end
    opt not enough USDC on the loan chain
        AG->>X: signed quote: NEAR USDC to loan-chain USDC, recipient = D, refund = policy
        X-->>AG: depositAddress + 1Click signature
        AG->>P: fund_bridge(quote, signature)
        Note over P: checks ed25519 signature, recipient, refund, assets, max 2% loss, fresh, unused, bridge budget
        P->>X: ft_transfer USDC to depositAddress (+ service fee in the same batch)
        X->>D: USDC delivered on the loan chain
        AG->>X: poll status until SUCCESS
    end
    AG->>P: rescue(amount, nonce, max fee, gas limit)
    Note over P: checks agent, not paused, amount, daily cap, cooldown, fee and gas caps, then builds repay(USDC, amount, 2, borrower)
    P->>M: sign(keccak256 of the EIP-1559 tx)
    M-->>P: big_r, s, recovery_id
    Note over P: low-s, ecrecover must equal D, else budget rolled back
    P-->>AG: signed tx
    Note over AG: re-checks to, calldata, nonce, chain id, signer
    AG->>D: eth_sendRawTransaction
    D->>AV: repay(USDC, amount, 2, borrower)
    AG->>AV: re-read HF, store the record and receipt
```

The two `opt` blocks are skipped when they are not needed (allowance already set, USDC already on the loan chain). If a bridge fails, the agent still repays with whatever USDC is already there.

### Inside the policy contract

```mermaid
flowchart TB
  OWN["Owner<br/>exactly 1 yoctoNEAR"]
  AGT["Agent account (the bot)<br/>checked by predecessor; the vault has no keys"]
  ANY["Anyone"]
  subgraph POLICY["Policy contract: contracts/policy/src"]
    OM["Owner methods<br/>set_limits, set_agent, set_on_behalf_of,<br/>set_bridge_signer, pause / unpause,<br/>withdraw, withdraw_near, close"]
    DEP["Deposits<br/>ft_on_transfer or plain ft_transfer<br/>no ledger: the USDC balance is the truth"]
    ACT["activate<br/>asks v1.signer.derived_public_key<br/>stores the derived address"]
    FB["fund_bridge"]
    BR["bridge.rs<br/>1Click ed25519 signature over the exact quote<br/>recipient = derived address, refund = policy<br/>USDC to USDC, max 2% loss, fresh, single use"]
    RS["rescue / approve_pool"]
    LIM["limits.rs<br/>pause, max per rescue, UTC-day cap,<br/>cooldown, fee and gas caps"]
    EV["evm.rs<br/>builds the EIP-1559 tx itself:<br/>repay(usdc, amount, 2, borrower) or approve(pool, daily_cap)<br/>low-s check, ecrecover"]
  end
  OWN --> OM
  ANY --> DEP
  ANY --> ACT
  AGT --> FB --> BR --> LIM
  AGT --> RS --> LIM --> EV
  EV -->|"sign(hash)"| MPC["v1.signer"]
  BR -->|"ft_transfer"| ONE["1Click deposit address"]
```

## How Backstop uses Aave

| What | How | Where |
| --- | --- | --- |
| Pool address | Never hardcoded: `AaveV3Base` / `AaveV3Arbitrum` from `@bgd-labs/aave-address-book`, stored in the policy at creation and re-checked by the agent and the web | `packages/config/src/registry.ts` |
| Health factor | `Pool.getUserAccountData(borrower)` every 30 s: collateral, debt, liquidation threshold, HF (1e18) | `packages/adapters/lending-aave/src/read.ts` |
| USDC price and debt | Price from the Pool's own oracle (`ADDRESSES_PROVIDER().getPriceOracle()`); debt from the USDC variable-debt token `balanceOf(borrower)` | same |
| How much to repay | Exact integer formula, rounded up, so repaying that amount reaches the target HF | `packages/core/src/risk.ts` |
| The repay | `Pool.repay(USDC, amount, 2, borrower)`: Aave lets anyone repay **on behalf of** a borrower, so the loan never moves and the derived address never owns the position | built in `contracts/policy/src/evm.rs` |
| The allowance | `USDC.approve(Pool, daily_cap)`: exact amount, never unlimited, once an hour | `approve_pool` |
| Arbitrum | Aave's `USDC` there is the bridged USDC.e; Backstop uses the native-USDC market (`USDCn`) that 1Click delivers | registry, tests in `apps/agent/test/checks.test.ts` |

## How Backstop uses NEAR

| What | How |
| --- | --- |
| Policy contract (vault) | Rust near-sdk 5.30, one per user and loan chain, created with **no access key**, so nobody can bypass its code or upgrade it. Operator-made vaults: one transaction (create account, deploy, init, activate). Factory vaults: the user's one transaction creates, deploys and initialises; `activate` and the USDC storage registration run in the factory's callback as separate receipts |
| Vault factory | Keyless, immutable contract (in progress, not deployed) that creates a vault for the caller and charges the storage deposit to the caller, returned on `close`. Chain allow-list, fee cap and policy wasm are fixed at `new`; see the next section |
| Chain Signatures | The policy calls `v1.signer.sign` with a 32-byte hash (`payload_v2.Ecdsa`, path `backstop-base-1`, domain 0). The signer derives a key from (policy account, path), so the EVM address is controlled by the policy's code alone. `activate` reads the address from `v1.signer.derived_public_key`, and the agent re-derives it two other ways |
| Owner vs agent | Owner methods need exactly 1 yoctoNEAR, which a function-call key cannot attach. The agent is a NEAR account (the bot account for factory vaults, with a full-access key held in the operator's secret store). Each vault accepts `rescue`, `fund_bridge` and `approve_pool` only from its agent account |
| NEAR Intents (1Click) | Funds enter from any chain via a deposit address; the policy pays 1Click only for a quote 1Click signed, verified on-chain with `env::ed25519_verify` |
| NEP-141 / NEP-297 | USDC is the NEAR native USDC token; every state change emits a NEP-297 `EVENT_JSON` log |
| NEAR AI Cloud | Short human-readable rescue receipt; a template is used if it is down, and it never blocks a rescue |

## Self-serve vaults and the bot account (in progress)

Users are meant to create their own vault: a keyless **vault factory** creates it from one wallet
confirmation, the user's deposit (about 2.93 NEAR, computed on chain) is the vault's storage and comes back
on `close` less about 0.007 NEAR, and the operator pays only the one-time factory deploy (4.86 NEAR
including gas, computed from the 469 KB factory wasm) and the bot's gas. The factory has a fixed chain allow-list set at `new`,
no setters, no access keys, and embeds the policy wasm, so every vault runs the factory's `policy_code_hash`.
Vault names are `<chain>-<n>.<factory>`, with `n` from a counter, so the caller never picks a name and a
closed vault's name is never reissued. The factory's default agent is one **bot account**: every
new vault names it as agent, so the bot starts watching the vault without an operator step. The bot
serves all vaults in one process (discover, check that each vault matches the registry and names the
bot, watch, act per vault). The bot's key is in the operator's secret store and the account holds about 2
NEAR. Status: the factory contract and 34 host unit tests are written; the factory deploy script and the
web create flow are not written; the multi-vault bot service is in progress. None is deployed or run on mainnet.

## Status

| Part | Path | State |
| --- | --- | --- |
| Policy contract v2 | [`contracts/policy`](../contracts/policy) | Built; 151 unit tests; clippy clean; wasm 277 KB (`--cfg near` + wasm-opt) |
| Vault factory | [`contracts/factory`](../contracts/factory) | In progress: contract and 34 host unit tests pass; deploy script and web create flow not written; **not deployed**; not run on mainnet |
| Packages | [`packages/*`](../packages) | Built and tested |
| Agent v2 | [`apps/agent`](../apps/agent) | Built; tested with fakes; not run on mainnet |
| Multi-vault bot service | [`apps/agent`](../apps/agent) | In progress: one bot account for every vault; not run on mainnet |
| Web | [`apps/web`](../apps/web) | Landing, `/app`, `/dashboard`, `/docs`, fund-from-any-chain routes; not tested with real wallets |
| Operator scripts | [`scripts/src`](../scripts/src) | `deploy-policy` (keyless, `--rehearsal`, `--redeploy`, `--finalize`), `policy status/print`, `derive`, `aave-setup status`; factory deploy planned |
| Mainnet rehearsal | — | Pending |

## The parts

### 1. Policy contract (NEAR, Rust) — `contracts/policy`

One per vault (one per user and loan chain), created with no access keys. State: owner, agent, borrower
(`on_behalf_of`), derived `base_address` (computed on-chain by `activate` from
`v1.signer.derived_public_key`), chain id, Aave Pool, USDC on Base and NEAR, 1Click destination asset and
quote key, limits, rescue and bridge budgets, pending signatures and bridges, used quote hashes.

- **Deposits:** any sender may send USDC (`ft_transfer_call` or plain `ft_transfer`). No ledger.
- **Owner:** `set_limits`, `set_agent`, `set_on_behalf_of`, `set_bridge_signer`, `unpause`,
  `withdraw`, `withdraw_near` (1 yoctoNEAR each), `pause` (no deposit).
- **Agent:** `fund_bridge(quote, signature)` pays a 1Click deposit address after verifying the
  quote ([`bridge.rs`](../contracts/policy/src/bridge.rs)); `rescue(...)` and `approve_pool(...)`
  build a Base tx ([`evm.rs`](../contracts/policy/src/evm.rs)), reserve budget, call `v1.signer.sign`
  and return the signed tx from `on_signed` after ecrecover against `base_address`.

### 2. Agent (TypeScript) — `apps/agent`

`cli.ts` checks at startup that the policy is keyless, activated, and its config and derived
address match the registry and two independent derivations. Each pass (`rescue.ts` `runOnce`):

1. Read limits/status from the policy; HF, debt and USDC price for the borrower from Aave.
2. Decide with the pure risk engine (`packages/core`).
3. If the allowance is low: `approve_pool`, verify, broadcast.
4. If USDC on Base is short: resume a bridge still in flight, else `bridgeQuote` (non-dry
   `EXACT_INPUT` 1Click quote, verified locally) → `fund_bridge` → submit deposit → poll status.
   A bridge problem never stops a repay with what is already on Base.
5. `rescue` → verify the signed tx (kind, to, data, nonce, hash, signer) → store it → broadcast
   with retries → wait → re-read HF → record + receipt.

A signed repay that could not be broadcast stays resumable (`resumeSignedRepay`, at startup and
before every watch pass) while its nonce is current. `--dry-run` sends nothing and needs no keys.
The multi-vault service (in progress) runs the same pass per vault, with one lock per vault and one
submit queue per NEAR key.

### 3. Packages — `packages/*`

| Package | Role |
| --- | --- |
| `core` | Types and the pure risk engine (`repayNeeded`, `decideRescue`). |
| `adapters/lending-aave` | Aave v3 reads (position, oracle price, USDC variable debt) and calldata. |
| `mover` | 1Click: assets, quotes, signed-quote canonicalisation and verification (same checks as the contract), deposit submit, status. |
| `chains` | viem Base client with fallback; near-api-js provider with failover (definitive errors returned at once). |
| `signer` | Derive the policy's Base address with chainsig.js and via the `v1.signer` view. |
| `db` | Rescue records: `rescues.json` or Postgres (Drizzle) when `DATABASE_URL` is set. |
| `receipts` | NEAR AI Cloud receipt text with a template fallback; never blocks a rescue. |
| `config` | Chain and protocol registry (addresses from official sources), typed `.env`. |

### 4. Web — `apps/web`

Next.js 16. Landing and `/docs` ship no wallet code. `/app` loads NEAR Connect (NEAR wallets, incl.
"Ethereum Wallets") and wagmi (EVM wallets). Steps: connect NEAR → connect EVM → find and verify the
policy → deposit (from NEAR, or **from another chain** via `/api/fund/quote` + `/api/fund/status`)
→ gas on Base → manage. Every action goes through one review dialog and one wallet prompt. Server
routes hold no keys except an optional 1Click API key. The create-vault flow (planned) reads the factory
and refuses unless it has no keys and matches the registry.

## Repay formula

From [`packages/core/src/risk.ts`](../packages/core/src/risk.ts) (`repayNeeded`), verbatim:

```
USDC (6 decimals) to repay so the health factor reaches `targetHfBps`.

Aave v3: HF = (totalCollateralBase * liqThresholdBps / 10000) / totalDebtBase,
all "Base" values are USD with 8 decimals.

Repaying R (in base units) lowers debt. Target HF_t requires
  debt' = collateral * LT / HF_t
so
  R = debt - collateral * LT / HF_t            (clamped at >= 0)
  amountUsdc = ceil(R * 10^6 / usdcPriceBase)

With HF_t = targetHfBps / 10000 and LT in bps the bps factors cancel:
  R = debt - collateral * LT_bps / targetHfBps
  amountUsdc = ceil((debt * targetHfBps - collateral * LT_bps) * 10^6 / (targetHfBps * usdcPriceBase))
Everything is bigint and the division is done once, rounding UP, so repaying `amountUsdc`
always reaches the target and repaying one unit (0.000001 USDC) less does not.
```

`decideRescue` then applies, in order: no debt → none; HF ≥ trigger → none; paused → blocked;
cooldown → blocked; daily cap used up → blocked; otherwise rescue
`min(needed, maxPerRescue, remainingToday)`. The contract enforces the same limits again on-chain;
the off-chain check only avoids asking for a rescue that would be rejected.

## Failure handling

| Failure | What happens |
| --- | --- |
| 1Click down or quote rejected | No bridge; repay with the USDC already on Base (partial repay), or skip. `ERR_QUOTE_*` turns bridging off for the run. |
| Bridge refunded | USDC returns to the policy on NEAR; recorded as failed. |
| Bridge in flight when the agent restarts | Resumed from `get_status().last_bridge`, not quoted again. |
| MPC signing fails | Budget rolled back; agent's NEAR tx fails visibly. |
| Base RPC fails on broadcast | Retried in the pass; the signed repay stays resumable; a signed approve is re-sent. |
| Bot account out of NEAR | Every vault's agent calls fail visibly until it is topped up; no funds move. Low-balance alert planned. |
| Owner pauses | Rescues, bridges and agent approvals stop; withdrawals still work. |
