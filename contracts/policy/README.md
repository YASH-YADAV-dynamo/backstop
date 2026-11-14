# backstop-policy

The Backstop v2 policy contract (Rust, near-sdk 5.30). One instance per user, deployed **with no
access keys**. It holds the user's rescue USDC on NEAR, enforces the user's limits, pays 1Click only
for quotes signed by 1Click that deliver to its own Base address, and builds the only two Base
transactions it will ever have `v1.signer` sign:

- `repay(usdc_base, amount, 2, on_behalf_of)` to `aave_pool` (selector `0x573ade81`), and
- `approve(aave_pool, daily_cap)` on `usdc_base` (selector `0x095ea7b3`),

both EIP-1559, `value = 0`, `chain_id` from state, fee and gas capped.

Method, error and
event reference: [`docs/site/05-policy-contract.md`](../../docs/site/05-policy-contract.md). Claims → tests:
[`docs/JUDGES.md`](../../docs/JUDGES.md).

## Layout

| File | What |
| --- | --- |
| `src/lib.rs` | State, init/activate, owner methods, deposits, `fund_bridge`, `rescue`, `approve_pool`, callbacks, views, events |
| `src/bridge.rs` | 1Click signed-quote verification (ed25519 over the exact bytes) and routing checks |
| `src/limits.rs` | Limits, UTC-day budgets, `check_rescue`, `check_bridge`, `check_tx_params` |
| `src/evm.rs` | Calldata, EIP-1559 tx, MPC signature parsing, low-s, ecrecover |
| `src/time.rs` | Strict ISO-8601 UTC parser for quote times |
| `src/tests.rs` | Unit tests named after the claim they prove (incl. a recorded live 1Click quote) |
| `tests/fixtures/quote.json` | The recorded live 1Click quote |

## Methods

See [`docs/site/05-policy-contract.md`](../../docs/site/05-policy-contract.md).

## Build

```bash
rustup target add wasm32-unknown-unknown
pnpm contract:build     # from the repo root
```
This runs `cargo build --target wasm32-unknown-unknown --release` with `--cfg near` (near-sdk's
on-chain mode: host sha256/keccak256 and `panic_utf8`, so `ERR_*` messages reach callers; set in
`.cargo/config.toml`), then `wasm-opt -Oz` (binaryen 131.0.0, pinned in the root `package.json`) into
`target/near/backstop_policy.wasm`, then `scripts/check-wasm.mjs`, which fails unless the wasm
imports `env.panic_utf8`, `env.sha256` and `env.keccak256` and prints the size and sha256. Current
output: 272,288 bytes. A mocked-host run of 54 calls gives byte-identical results before and after
wasm-opt. The deploy script picks `target/near/` first. near-sdk 5.30 declares
`min_protocol_version = 85`; mainnet runs protocol 88 (bulk-memory and sign-ext enabled).

## Test

```bash
cargo test
```
The unit tests need `near-sdk/unit-testing`, which compiles C (aws-lc-sys, secp256k1-sys, blst,
zstd-sys). On Windows that needs the MSVC C++ build tools; without them run the tests in WSL/Linux.
Visibility of `#[private]` / `#[init]` methods (`new`, `on_derived_key`, `on_withdrawn`, `on_bridge_funded`, `fail_bridge`, `on_signed`, `fail_rescue`) is enforced in the wasm entry
points and is not exercised by unit tests (no sandbox tests yet). The mainnet rehearsal checks them (see Deploy).

## Deploy (mainnet, operator script)

Use `scripts/src/deploy-policy.ts`; it creates `<name>.<deployer>` in **one** transaction:
CreateAccount, Transfer, DeployContract, `new`, `activate` (no AddKey), checks the key list is empty
and the code hash matches, then registers the policy on NEAR USDC. Dry run by default.

```bash
pnpm contract:build
pnpm --filter @backstop/scripts deploy-policy --name alice --owner alice.near --borrower 0x... [--agent agent.near] [--send]
```

**First mainnet policy: rehearsal.** A keyless contract cannot be fixed, so the first one is created
with `--rehearsal` (one temporary full-access key of the deployer), exercised end to end (activate,
deposit, withdraw, `fund_bridge`, `approve_pool`, `rescue`, plus a second `new`, a stranger calling a
callback, a deposit attached to `rescue` — all must fail), fixed with `--redeploy <policy>` if
needed, and made keyless for good with `--finalize <policy> --send`. The agent accepts the
rehearsal policy only with `--allow-keyed-rehearsal`; the web never does.

Budget: about 2.77 NEAR of code storage (277 KB wasm; returned to the owner by `close`) + 0.05 state +
0.1 spare + 0.00125 USDC registration. The script prints the exact amount.

After deploy, give the agent a function-call key limited to `rescue`, `fund_bridge`,
`approve_pool` on the policy (the script prints the near-cli-rs command).
