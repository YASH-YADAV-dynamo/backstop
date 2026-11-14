import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const dynamic = "force-static";

/** Serves the repo-root llms.txt. */
export async function GET() {
  const file = join(process.cwd(), "..", "..", "llms.txt");
  try {
    return new Response(await readFile(file, "utf8"), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  } catch {
    return new Response("llms.txt has not been written yet. See /docs.\n", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}
