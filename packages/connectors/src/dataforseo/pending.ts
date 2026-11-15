import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** DataforSEO keeps standard-queue results for 30 days; older saved task ids are posted again. */
export const PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/** A standard-queue task that was posted (and paid for) but whose result isn't in the cache yet. */
export interface PendingTask {
  taskId: string;
  endpoint: string;
  payload: unknown;
  postedAt: string;
  costUsd: number;
}

/**
 * Posted task ids by request hash, one JSON file each. DataforSEO charges at task_post, so a run
 * that stops before task_get (timeout, crash, Ctrl+C) would pay again on the next run. With the
 * id on disk the next run collects the same task instead.
 */
export class PendingTasks {
  constructor(readonly dir: string) {}

  private path(hash: string): string {
    return join(this.dir, `${hash}.json`);
  }

  get(hash: string): PendingTask | null {
    const p = this.path(hash);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8")) as PendingTask;
  }

  set(hash: string, task: PendingTask): void {
    const p = this.path(hash);
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(`${p}.tmp`, JSON.stringify(task));
    renameSync(`${p}.tmp`, p);
  }

  delete(hash: string): void {
    rmSync(this.path(hash), { force: true });
  }
}
