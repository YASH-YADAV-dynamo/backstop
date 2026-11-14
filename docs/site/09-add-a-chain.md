---
title: Add a chain
description: The checklist for supporting another Aave v3 chain. One registry entry, no contract change.
order: 9
---

# Add a chain

Backstop protects an Aave v3 loan on any EVM chain that Aave v3, NEAR Intents 1Click and Chain
Signatures all support. The policy contract needs **no change**: it already takes the chain id, Aave
Pool, USDC and 1Click destination asset when it is created. Everything chain-specific lives in
`LOAN_CHAINS` in `packages/config/src/registry.ts`.

## Steps

1. **Aave addresses.** Add the chain's entry from `@bgd-labs/aave-address-book` (never hardcode). Use the
   **native Circle USDC** market. On Arbitrum that is `USDCn`; Aave's plain `USDC` there is the old
   bridged USDC.e, which 1Click does not deliver.
2. **1Click asset id.** Read it from `GET https://1click.chaindefuser.com/v0/tokens` (symbol `USDC`,
   same contract address as step 1, 6 decimals). Add it to `ONE_CLICK` and to the entry.
3. **Chain entry.** Add `{ chainId, key, name, explorer, rpcUrls, rpcEnvVar, aave, usdcAssetId, oneClickChain }`
   to `LOAN_CHAINS`, and the `rpcEnvVar` name to the `LoanChain` type and `.env.example`.
4. **viem chain.** Add it to the chain map in `packages/chains/src/evm.ts` and the web's wagmi config.
5. **Tests.** The registry test already checks every entry (native USDC matches the 1Click asset id).
   Run `pnpm check`.
6. **Rehearse.** Create a policy with `deploy-policy --chain <key> ...`, fund it, run one rescue, and
   record the transaction links in `docs/JUDGES.md`.

Not covered by this checklist: protocols other than Aave v3 (new calldata builders and contract
code) and non-EVM chains.
