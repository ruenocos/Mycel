import type { SerializedError } from "./types.ts";

export function serializeError(err: unknown, depth = 0): SerializedError {
  if (err instanceof Error) {
    const out: SerializedError = { name: err.name, message: err.message };
    if (err.stack) out.stack = err.stack;
    if (err.cause !== undefined && depth < 5) out.cause = serializeError(err.cause, depth + 1);
    return out;
  }
  return { name: "NonError", message: typeof err === "string" ? err : JSON.stringify(err) };
}
