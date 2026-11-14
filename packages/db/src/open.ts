import type { Env } from "@backstop/config";
import { JsonFileStore } from "./json-store.js";
import { PostgresStore } from "./pg-store.js";
import type { RescueStore } from "./record.js";

/** Postgres when DATABASE_URL is set, else the JSON file at RESCUES_FILE. */
export async function openStore(env: Pick<Env, "DATABASE_URL" | "RESCUES_FILE">): Promise<RescueStore> {
  if (env.DATABASE_URL) return PostgresStore.open(env.DATABASE_URL);
  return new JsonFileStore(env.RESCUES_FILE);
}
