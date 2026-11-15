import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface LedgerEntry {
  at: string;
  endpoint: string;
  requestHash: string;
  costUsd: number;
}

/**
 * Every paid call, one JSON line each in <dir>/<YYYY-MM>.jsonl. Runs come and go; this is the
 * only place that knows what the whole month cost, so a monthly cap can hold across runs
 * (ADR 0004). Append-only, so two runs at the same time can't overwrite each other's lines.
 */
export class SpendLedger {
  private month = "";
  private total = 0;

  constructor(
    readonly dir: string,
    private readonly now: () => Date = () => new Date(),
    /** What the month already cost before this ledger existed (from the response cache). */
    private readonly backfill: (month: string) => LedgerEntry[] = () => [],
  ) {}

  private path(month: string): string {
    return join(this.dir, `${month}.jsonl`);
  }

  /** One month's entries, read without creating or seeding anything (for a cost preview). */
  static read(dir: string, month: string): LedgerEntry[] {
    const p = join(dir, `${month}.jsonl`);
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as LedgerEntry);
  }

  /** What the most recent paid call to an endpoint cost, looking back through the months. */
  static lastCost(dir: string, endpoint: string): number | undefined {
    if (!existsSync(dir)) return undefined;
    const months = readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f))
      .sort()
      .reverse();
    for (const file of months) {
      const paid = SpendLedger.read(dir, file.slice(0, 7)).filter(
        (e) => e.endpoint === endpoint && e.costUsd > 0,
      );
      const last = paid.at(-1);
      if (last) return last.costUsd;
    }
    return undefined;
  }

  private append(month: string, entries: LedgerEntry[]): void {
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(this.path(month), entries.map((e) => `${JSON.stringify(e)}\n`).join(""));
  }

  /** Calendar month in UTC, e.g. "2026-11". */
  currentMonth(): string {
    return this.now().toISOString().slice(0, 7);
  }

  /** USD spent this calendar month, by every run that used this ledger. */
  spentThisMonth(): number {
    const month = this.currentMonth();
    if (month !== this.month) {
      const p = this.path(month);
      // Seed only on first load: after a roll-over mid-run, this run's own calls get added below.
      if (!existsSync(p)) this.append(month, this.month === "" ? this.backfill(month) : []);
      this.total = readFileSync(p, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .reduce((sum, line) => sum + ((JSON.parse(line) as LedgerEntry).costUsd || 0), 0);
      this.month = month;
    }
    return Math.round(this.total * 1e6) / 1e6;
  }

  add(entry: Omit<LedgerEntry, "at">): void {
    if (!(entry.costUsd > 0)) return;
    this.spentThisMonth(); // loads the month, and rolls over when a run crosses midnight on the 1st
    this.append(this.month, [{ at: this.now().toISOString(), ...entry }]);
    this.total += entry.costUsd;
  }
}
