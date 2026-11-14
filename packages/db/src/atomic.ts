/**
 * Atomic file write: the content goes to a temp file in the same directory, which is then renamed
 * over the target, so readers never see a half-written file.
 */
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await writeFile(tmp, content, "utf8");
  // Windows can briefly refuse the rename while another process has the target open (EPERM/EBUSY).
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, filePath);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code === "EPERM" || code === "EBUSY" || code === "EACCES") && attempt < 5) {
        await sleep(50 * (attempt + 1));
        continue;
      }
      await rm(tmp, { force: true });
      throw new Error(`Could not write ${filePath} (${code ?? String(err)}). Close programs holding the file and retry.`);
    }
  }
}
