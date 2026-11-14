# Builds the policy wasm inside WSL because this Windows machine has no MSVC linker for Rust.
# Expects a WSL distro named Fedora with gcc and dnf available.
# Run from Windows via `pnpm policy:build:wsl` (wsl -d Fedora -- bash scripts/wsl-build-policy.sh).
# The first run installs Rust (rustup) and binaryen (dnf) inside WSL only; nothing is installed on Windows.
# Output: contracts/policy/target/near/backstop_policy.wasm, then checked with scripts/check-wasm.mjs if node exists.
# Works from any clone path: the repo root is derived from this script's location.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ ! -x "$HOME/.cargo/bin/rustup" ]; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain none
fi
. "$HOME/.cargo/env"
rustup toolchain install stable --profile minimal
rustup default stable
rustup target add wasm32-unknown-unknown --toolchain stable
if ! command -v wasm-opt >/dev/null 2>&1; then
  dnf install -y binaryen
fi
cargo --version
rustc --version
wasm-opt --version
export CARGO_TARGET_DIR="$HOME/backstop-target/policy"
cd "$ROOT/contracts/policy"
# rustflags (--cfg near, strip) come from contracts/policy/.cargo/config.toml; do not set RUSTFLAGS here.
cargo build --target wasm32-unknown-unknown --release
mkdir -p "$HOME/backstop-out"
wasm-opt -Oz --strip-debug --strip-producers --enable-bulk-memory --enable-sign-ext --enable-mutable-globals \
  "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/backstop_policy.wasm" -o "$HOME/backstop-out/backstop_policy.wasm"
ls -l "$HOME/backstop-out/backstop_policy.wasm"
sha256sum "$HOME/backstop-out/backstop_policy.wasm"
mkdir -p "$ROOT/contracts/policy/target/near"
cp "$HOME/backstop-out/backstop_policy.wasm" "$ROOT/contracts/policy/target/near/backstop_policy.wasm"
cd "$ROOT"
if command -v node >/dev/null 2>&1; then
  node scripts/check-wasm.mjs contracts/policy/target/near/backstop_policy.wasm
else
  echo "NOTE: node not found in WSL; skipping scripts/check-wasm.mjs. Install Node >=20 in WSL to run the check."
fi
