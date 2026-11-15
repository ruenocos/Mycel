import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { serializeError } from "./errors.ts";
import { redact } from "./redact.ts";
import type { LogLevel, LogLine } from "./types.ts";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogSink {
  write(line: LogLine): void;
}

/** Appends one JSON line. Sync on purpose: a crash must not lose the last lines. */
export function appendJsonLine(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(value)}\n`);
}

export function fileSink(path: string): LogSink {
  return { write: (line) => appendJsonLine(path, line) };
}

/** Mirrors log lines to the console while a run is going (--debug). */
export function consoleSink(minLevel: LogLevel = "info"): LogSink {
  return {
    write(line) {
      if (ORDER[line.level] < ORDER[minLevel]) return;
      const where = line.step ? ` [${line.step}]` : "";
      const data = line.data ? ` ${JSON.stringify(line.data)}` : "";
      const err = line.err ? ` ${line.err.name}: ${line.err.message}` : "";
      const out = `${line.ts.slice(11, 23)} ${line.level.padEnd(5)}${where} ${line.msg}${data}${err}`;
      // Always stderr: stdout is the result of a command, and stays the same with --debug on.
      process.stderr.write(`${out}\n`);
    },
  };
}

export function memorySink(): LogSink & { lines: LogLine[] } {
  const lines: LogLine[] = [];
  return {
    lines,
    write(line) {
      lines.push(line);
    },
  };
}

export function multiSink(...sinks: LogSink[]): LogSink {
  return {
    write(line) {
      for (const s of sinks) s.write(line);
    },
  };
}

export interface LogOptions {
  event?: string;
  data?: Record<string, unknown>;
}

export class Logger {
  constructor(
    private readonly sink: LogSink,
    readonly runId: string,
    readonly step?: string,
    private readonly secrets: readonly string[] = [],
  ) {}

  child(step: string): Logger {
    return new Logger(this.sink, this.runId, step, this.secrets);
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    this.emit("debug", msg, data ? { data } : {});
  }
  info(msg: string, data?: Record<string, unknown>): void {
    this.emit("info", msg, data ? { data } : {});
  }
  warn(msg: string, data?: Record<string, unknown>): void {
    this.emit("warn", msg, data ? { data } : {});
  }
  /** Always pass the caught error: no silent catch blocks (CLAUDE.md). */
  error(msg: string, err?: unknown, data?: Record<string, unknown>): void {
    this.emit("error", msg, data ? { data } : {}, err);
  }

  event(
    level: LogLevel,
    event: string,
    msg: string,
    data?: Record<string, unknown>,
    err?: unknown,
  ) {
    this.emit(level, msg, data ? { event, data } : { event }, err);
  }

  private emit(level: LogLevel, msg: string, opts: LogOptions, err?: unknown): void {
    const line: LogLine = { ts: new Date().toISOString(), level, runId: this.runId, msg };
    if (this.step) line.step = this.step;
    if (opts.event) line.event = opts.event;
    if (opts.data) line.data = redact(opts.data, this.secrets);
    if (err !== undefined) line.err = redact(serializeError(err), this.secrets);
    this.sink.write(line);
  }
}
