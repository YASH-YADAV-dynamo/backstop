# wallet-test (standalone, mainnet)
Proves a NEAR wallet can sign `near.create_account` with a 0.1 NEAR deposit.
Run: `cd tools/wallet-test && python -m http.server 8080`, open http://localhost:8080
(use localhost, not file://). Needs internet for the CDN and NEAR RPC.
1. Connect wallet. 2. Create test account, approve in wallet, wait for PASS/FAIL. 3. Copy log.
Refund (manual): click "Show throwaway secret", then with near-cli-rs:
`near account delete-account bkst-test-XXXX.near beneficiary <your account> network-config mainnet`
and supply the secret when asked (or import it into a wallet). Keep the key throwaway.
