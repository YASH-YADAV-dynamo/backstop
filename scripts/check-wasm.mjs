// Guards a contract wasm built by `pnpm policy:build` / `pnpm factory:build`:
// it must be an on-chain (`--cfg near`) build, so panics carry ERR_* text and hashing uses host functions.
// Usage: node scripts/check-wasm.mjs <wasm> [--embeds=<inner.wasm>] [required imports...] (default: the policy's three).
// --embeds: the factory must carry the policy wasm byte for byte (its build skips wasm-opt's memory-packing for that).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) throw new Error("usage: node scripts/check-wasm.mjs <wasm> [module.import ...]");
const code = readFileSync(path);
const imports = WebAssembly.Module.imports(new WebAssembly.Module(code)).map((i) => `${i.module}.${i.name}`);
const args = process.argv.slice(3);
const embeds = args.filter((a) => a.startsWith("--embeds=")).map((a) => a.slice("--embeds=".length));
const extra = args.filter((a) => !a.startsWith("--embeds="));
const required = extra.length ? extra : ["env.panic_utf8", "env.sha256", "env.keccak256"];
const missing = required.filter((r) => !imports.includes(r));
if (missing.length) {
  console.error(`${path} lacks ${missing.join(", ")}: built without --cfg near. Check the crate's .cargo/config.toml.`);
  process.exit(1);
}
for (const inner of embeds) {
  if (code.indexOf(readFileSync(inner)) < 0) {
    console.error(`${path} does not contain ${inner} byte for byte: rebuild the policy first, then this crate.`);
    process.exit(1);
  }
}
console.log(`${path}: ${code.length} bytes, sha256 ${createHash("sha256").update(code).digest("hex")}, imports OK`);
