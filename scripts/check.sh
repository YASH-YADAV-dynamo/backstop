#!/usr/bin/env bash
# One command, everything in parallel: contracts (policy + factory: tests + clippy + optimised wasm) and TypeScript
# (typecheck + tests + lint). Turbo caches the TypeScript side, so an unchanged package costs ~0 s.
set -u
cd "$(dirname "$0")/.."
fail=0
run() { # name, command...
  local name=$1; shift
  ( "$@" >"/tmp/backstop-check-$name.log" 2>&1 && echo "ok    $name" ) || { echo "FAIL  $name  (log: /tmp/backstop-check-$name.log)"; return 1; }
}
run contract-test   bash -c 'cd contracts/policy && cargo test --offline' &
p1=$!
run contract-clippy bash -c 'cd contracts/policy && cargo clippy --offline --all-targets -- -D warnings' &
p2=$!
# The factory embeds the policy wasm (include_bytes!), so its tests and clippy need that file; build it first
# when missing (the full rebuild below then re-checks both).
[ -f contracts/policy/target/near/backstop_policy.wasm ] || pnpm policy:build >/tmp/backstop-check-policy-wasm.log 2>&1
run factory-test    bash -c 'cd contracts/factory && cargo test --offline' &
p4=$!
run factory-clippy  bash -c 'cd contracts/factory && cargo clippy --offline --all-targets -- -D warnings' &
p5=$!
run typescript      bash -c 'pnpm typecheck && pnpm test && pnpm lint' &
p3=$!
for p in $p1 $p2 $p3 $p4 $p5; do wait "$p" || fail=1; done
# The wasm builds reuse the compiled crates, so they run after the tests (policy, then the factory that embeds it).
run contract-wasm   pnpm contract:build || fail=1
grep 'bytes, sha256' /tmp/backstop-check-contract-wasm.log 2>/dev/null
exit $fail
