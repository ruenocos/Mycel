import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** JSON with sorted keys, so equal requests always hash the same. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function requestHash(endpoint: string, payload: unknown): string {
  return createHash("sha256")
    .update(`${endpoint}\n${stableStringify(payload)}`)
    .digest("hex")
    .slice(0, 32);
}

export interface CacheEntry<T = unknown> {
  endpoint: string;
  payload: unknown;
  fetchedAt: string;
  costUsd: number;
  result: T;
}

/** Responses stored by request hash, one JSON file each (CLAUDE.md: cache every paid call). */
export class FileCache {
  constructor(readonly dir: string) {}

  private path(hash: string): string {
    return join(this.dir, hash.slice(0, 2), `${hash}.json`);
  }

  get<T>(hash: string): CacheEntry<T> | null {
    const p = this.path(hash);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8")) as CacheEntry<T>;
  }

  set<T>(hash: string, entry: CacheEntry<T>): void {
    const p = this.path(hash);
    mkdirSync(join(this.dir, hash.slice(0, 2)), { recursive: true });
    writeFileSync(`${p}.tmp`, JSON.stringify(entry));
    renameSync(`${p}.tmp`, p);
  }
}
