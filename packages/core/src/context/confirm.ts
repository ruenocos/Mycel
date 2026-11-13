import { ClientContext } from "@mycel/schema";

/**
 * The human half of steps 1-6: every field of a proposed context is shown, kept or edited,
 * and the context is marked confirmed only when nothing is left unreviewed.
 */

/** Fields a person reviews, in the order the terminal asks them. Lists are edited as "a; b; c". */
export const REVIEW_FIELDS = [
  "market",
  "sourceContext",
  "centralEntities",
  "centralSearchIntent",
  "audiences",
  "offerings",
  "competitors",
] as const;
export type ReviewField = (typeof REVIEW_FIELDS)[number];

const LIST_SEP = /\s*;\s*/;
const splitList = (s: string) =>
  s
    .split(LIST_SEP)
    .map((x) => x.trim())
    .filter(Boolean);

export function showField(ctx: ClientContext, field: ReviewField): string {
  switch (field) {
    case "market":
      return [ctx.market.country, ctx.market.language, ctx.market.city].filter(Boolean).join(" / ");
    case "centralEntities":
      return ctx.centralEntities
        .map(
          (e) =>
            `${e.name} = ${e.disambiguation}${e.notThis.length ? ` (not: ${e.notThis.join(", ")})` : ""}`,
        )
        .join("; ");
    case "audiences":
    case "offerings":
    case "competitors":
      return ctx[field].join("; ");
    default:
      return ctx[field];
  }
}

/**
 * Applies one edit typed in the terminal. Formats:
 * market "NL / nl / Utrecht"; central entities "name = meaning (not: a, b); next = ...";
 * lists "a; b; c"; text fields as typed.
 */
export function editField(ctx: ClientContext, field: ReviewField, value: string): ClientContext {
  const v = value.trim();
  let next: unknown;
  switch (field) {
    case "market": {
      const [country, language, city] = v.split(/\s*\/\s*/);
      next = {
        ...ctx,
        market: {
          country: (country ?? "").toUpperCase(),
          language: (language ?? "").toLowerCase(),
          ...(city ? { city } : {}),
        },
      };
      break;
    }
    case "centralEntities":
      next = {
        ...ctx,
        centralEntities: splitList(v).map((part) => {
          const m = /^(.+?)\s*=\s*(.+?)(?:\s*\(not:\s*(.*)\))?$/.exec(part);
          if (!m) return { name: part, disambiguation: part, notThis: [] };
          return {
            name: (m[1] ?? "").trim(),
            disambiguation: (m[2] ?? "").trim(),
            notThis: (m[3] ?? "").split(/\s*,\s*/).filter(Boolean),
          };
        }),
      };
      break;
    case "audiences":
    case "offerings":
    case "competitors":
      next = { ...ctx, [field]: splitList(v) };
      break;
    default:
      next = { ...ctx, [field]: v };
  }
  // Same rules as the step output: an edit can't produce an invalid context.
  return ClientContext.parse(next);
}

export function reviewAnswer(ctx: ClientContext, id: string, edited?: string): ClientContext {
  const answers = ctx.answers.map((a) => {
    if (a.id !== id) return a;
    const text = edited?.trim();
    return text && text !== a.answer
      ? { ...a, answer: text, status: "edited" as const }
      : { ...a, status: "confirmed" as const };
  });
  return ClientContext.parse({ ...ctx, answers });
}

export function unreviewed(ctx: ClientContext): string[] {
  return ctx.answers.filter((a) => a.status === "proposed").map((a) => a.id);
}

/** Stamps who confirmed it and when. Refuses while any answer is still only proposed. */
export function markConfirmed(ctx: ClientContext, by: string, at: Date): ClientContext {
  const open = unreviewed(ctx);
  if (open.length) throw new Error(`not confirmed: still unreviewed ${open.join(", ")}`);
  return ClientContext.parse({ ...ctx, confirmed: { by, at: at.toISOString() } });
}
