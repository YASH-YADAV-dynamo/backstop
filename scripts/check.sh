#!/usr/bin/env bash
# One command, everything in parallel: contract (tests + clippy + optimised wasm) and TypeScript
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
run typescript      bash -c 'pnpm typecheck && pnpm test && pnpm lint' &
p3=$!
for p in $p1 $p2 $p3; do wait "$p" || fail=1; done
# The wasm build reuses the compiled crates, so it runs after the tests.
run contract-wasm   pnpm contract:build || fail=1
tail -n1 /tmp/backstop-check-contract-wasm.log 2>/dev/null
exit $fail
