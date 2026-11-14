/**
 * Rescue records in one JSON file (default `rescues.json` at the repo root). Writes are atomic:
 * the whole array goes to a temp file in the same directory, which is then renamed over the
 * target, so readers never see a half-written file. Writes from this process are serialized.
 */
import type { RescueRecord } from "@backstop/core";
import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "./atomic.js";
import { applyPatch, parseRecord, type RescuePatch, type RescueStore } from "./record.js";

/** JSON has no Infinity: store it as "Infinity" (record.ts turns it back into a number). */
const replacer = (_key: string, value: unknown) =>
  typeof value === "number" && !Number.isFinite(value) ? "Infinity" : value;

const byTriggeredAt = (a: RescueRecord, b: RescueRecord) => Date.parse(a.triggeredAt) - Date.parse(b.triggeredAt);

export class JsonFileStore implements RescueStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly filePath: string) {}

  async list(): Promise<RescueRecord[]> {
    return (await this.read()).sort(byTriggeredAt);
  }

  async add(r: RescueRecord): Promise<void> {
    const record = parseRecord(JSON.parse(JSON.stringify(r, replacer)), "add()");
    return this.mutate((all) => {
      if (all.some((x) => x.id === record.id)) {
        throw new Error(`Rescue ${record.id} already exists in ${this.filePath}; use update() to change it.`);
      }
      all.push(record);
      return undefined;
    });
  }

  update(id: string, patch: RescuePatch): Promise<RescueRecord> {
    return this.mutate((all) => {
      const i = all.findIndex((x) => x.id === id);
      if (i < 0) throw new Error(`Rescue ${id} not found in ${this.filePath}; add() it first.`);
      const next = parseRecord(JSON.parse(JSON.stringify(applyPatch(all[i]!, patch), replacer)), `update(${id})`);
      all[i] = next;
      return next;
    });
  }

  async close(): Promise<void> {
    await this.queue.catch(() => undefined);
  }

  private async read(): Promise<RescueRecord[]> {
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    if (!text.trim()) return [];
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`${this.filePath} is not valid JSON. Fix or delete it (it only holds rescue history).`);
    }
    if (!Array.isArray(data)) {
      throw new Error(`${this.filePath} must contain a JSON array of rescue records. Fix or delete it.`);
    }
    return data.map((v, i) => parseRecord(v, `${this.filePath}[${i}]`));
  }

  /** Read-modify-write under the in-process queue, then write atomically. */
  private mutate<T>(fn: (all: RescueRecord[]) => T): Promise<T> {
    const run = this.queue.then(async () => {
      const all = await this.read();
      const result = fn(all);
      await writeFileAtomic(this.filePath, JSON.stringify(all, replacer, 2) + "\n");
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
