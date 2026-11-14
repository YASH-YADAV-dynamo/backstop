# get-near-test

Local, standalone tool (Node 22, zero dependencies): swap a little USDC on Base into NEAR via the NEAR Intents 1Click API, and report whether NATIVE NEAR or wNEAR arrived.

1. `node selftest.mjs` (offline checks of the helpers).
2. `node server.mjs`, then open http://127.0.0.1:8081 (binds to 127.0.0.1 only; optional env `ONE_CLICK_JWT` stays server-side).
3. Pick your wallet (Rabby/MetaMask), enter amount and your NEAR account, then run steps 1 to 4 in order.

Do a $1 test first. Cap is 15 USDC, minimum 0.5.

WARNING: this spends REAL money from the connected wallet. Nothing is sent until you approve the USDC transfer in the wallet, and the send button stays disabled until the quote passes the safety checks and you tick "I checked these".

Native vs wNEAR: the NEAR docs page on NEAR token deposits only describes the Verifier contract (NEP-141 only, wNEAR = `nep141:wrap.near`) and does not name a native-NEAR destination asset for 1Click. The page therefore reads `/v0/tokens`: if 1Click lists a separate "NEAR" token on the near chain it uses it, otherwise it falls back to `nep141:wrap.near` and shows an orange wNEAR warning.

Verdict lines (from NEAR RPC balances before and after, for the recipient):
- `NATIVE NEAR ARRIVED: +x NEAR`: spendable NEAR landed.
- `wNEAR ARRIVED: +x wNEAR (native unchanged)`: a token landed; unwrap via `wrap.near` `near_withdraw` (1 yoctoNEAR, account needs about 0.01 NEAR for gas).
- "Nothing arrived yet": use Re-check balances.

Not done: 1Click quote signature verification (the app does it; this tool checks fields only).
