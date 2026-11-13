// "token" alone would also hit inputTokens/outputTokens counts, so only auth-style token keys match.
const SECRET_KEY =
  /(api[-_]?key|secret|password|passwd|authorization|credential|bearer|^token$|(access|refresh|auth|id|session)[-_]?token)/i;
const MIN_SECRET_LENGTH = 8;
export const REDACTED = "[redacted]";

/** Values of environment variables that look like secrets, to scrub from anything we write. */
export function secretsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(env)
    .filter(([k]) => SECRET_KEY.test(k) || /(_KEY|_PASSWORD|_LOGIN|_TOKEN)$/i.test(k))
    .map(([, v]) => v ?? "")
    .filter((v) => v.length >= MIN_SECRET_LENGTH);
}

/** Deep copy with secret-looking keys and known secret values replaced. */
export function redact<T>(value: T, secrets: readonly string[] = []): T {
  const known = secrets.filter((s) => s.length >= MIN_SECRET_LENGTH);
  const walk = (v: unknown, seen: WeakSet<object>): unknown => {
    if (typeof v === "string") {
      let s = v;
      for (const secret of known) if (s.includes(secret)) s = s.split(secret).join(REDACTED);
      return s;
    }
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v)) return "[circular]";
    seen.add(v);
    if (Array.isArray(v)) return v.map((x) => walk(x, seen));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      out[k] =
        SECRET_KEY.test(k) && x !== undefined && x !== null && x !== "" ? REDACTED : walk(x, seen);
    }
    return out;
  };
  return walk(value, new WeakSet()) as T;
}
