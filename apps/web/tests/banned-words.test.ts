import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** v3 section 2: none of these may be on screen in the app. Only text a person can see is scanned (JSX text and visible string literals). */
const BANNED = [/\bMPC\b/, /\b1Click\b/, /\bnonce\b/i, /\byocto/i, /\bTGas\b/, /derived address/i, /\bpolic(y|ies)\b/i, /prototype/i, /unaudited/i, /small amounts/i, /hackathon/i, /storage stak/i];

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.tsx$/.test(e.name) ? [join(dir, e.name)] : []));
}

/** JSX text between tags, plus string literals that contain a space and a letter (class names and ids rarely do, and are filtered). */
export function visibleText(raw: string): string[] {
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const out: string[] = [];
  for (const m of source.matchAll(/>([^<>{}]*[A-Za-z][^<>{}]*)</g)) out.push(m[1]!.trim());
  for (const m of source.matchAll(/(["'`])((?:\\.|(?!\1).)*[A-Za-z]+ [A-Za-z][^\n]*?)\1/g)) {
    const text = m[2]!;
    if (/^[\w:/.\[\]%()#-]+( [\w:/.\[\]%()#!*&>-]+)*$/.test(text) && /[-:\[]/.test(text) && !/[.,?!]/.test(text)) continue; // Tailwind class lists
    out.push(text);
  }
  return out;
}

describe("no_banned_word_in_components_app", () => {
  const root = fileURLToPath(new URL("../components/app", import.meta.url));
  it("keeps internals and hackathon wording off the app screens", () => {
    const hits: string[] = [];
    for (const file of files(root)) {
      for (const text of visibleText(readFileSync(file, "utf8"))) {
        for (const re of BANNED) if (re.test(text)) hits.push(`${file.slice(root.length)}: "${text.slice(0, 80)}" matches ${re}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
