/**
 * Single-instance lock for the bot service (design v3 1.1: "a second instance exits").
 * Postgres: a session-level advisory lock held on a dedicated connection for the life of the process.
 * JSON mode: a lock file holding the owner's pid; a lock whose pid is no longer alive is taken over.
 */
import { open, readFile, rm } from "node:fs/promises";
import postgres from "postgres";

export interface InstanceLock {
  release(): Promise<void>;
}

/** Arbitrary constant key for pg_try_advisory_lock ("backstop" in ASCII hex, fits a bigint). */
export const SERVICE_LOCK_KEY = 0x6261636b73746f70n;

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

export async function acquireFileLock(lockPath: string): Promise<InstanceLock | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await open(lockPath, "wx");
      await fh.writeFile(String(process.pid));
      await fh.close();
      return { release: () => rm(lockPath, { force: true }) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const pid = Number((await readFile(lockPath, "utf8").catch(() => "")).trim());
      if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) return null;
      await rm(lockPath, { force: true }); // stale: its process is gone
    }
  }
  return null;
}

export async function acquirePgLock(databaseUrl: string): Promise<InstanceLock | null> {
  const client = postgres(databaseUrl, { max: 1, idle_timeout: 0, onnotice: () => undefined });
  const [row] = await client<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(${SERVICE_LOCK_KEY.toString()}::bigint) AS locked`;
  if (!row?.locked) {
    await client.end({ timeout: 5 });
    return null;
  }
  return { release: () => client.end({ timeout: 5 }) };
}

/** Null when another bot instance already holds the lock. */
export async function acquireInstanceLock(env: { DATABASE_URL?: string | undefined; VAULT_STATUS_FILE: string }): Promise<InstanceLock | null> {
  return env.DATABASE_URL ? acquirePgLock(env.DATABASE_URL) : acquireFileLock(`${env.VAULT_STATUS_FILE}.lock`);
}
