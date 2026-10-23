/**
 * The reading schema `kletia.reading/v2`: what a provider may
 * return for one masked clause. Every value is an enum or an evidence span
 * `[start, end)` over the numbered token list; no literal symbol, amount,
 * network, venue, address or name can be expressed. Holders are the person
 * only (no payment to anyone), there is no contract kind, and amounts are
 * the lexer's own tokens cited by span.
 *
 * `parseReading` is strict: unknown keys, wrong types or out-of-range spans
 * reject the whole answer.
 */
export const READING_SCHEMA_VERSION = "kletia.reading/v2";

export const READING_KINDS = ["convert", "relocate", "earn", "exit", "acquire"] as const;
export type ReadingKind = (typeof READING_KINDS)[number];
export const READING_OPS = ["swap", "bridge", "stake", "deposit", "withdraw"] as const;
export type ReadingOp = (typeof READING_OPS)[number];
export const READING_VERDICTS = ["reading", "unclear", "unsupported"] as const;

export type SpanRef = readonly [number, number];

export interface ReadingGoal {
  readonly kind: ReadingKind;
  readonly op?: ReadingOp;
  readonly verb: SpanRef;
  readonly spend?: { readonly asset?: SpanRef; readonly amount?: SpanRef; readonly network?: SpanRef };
  readonly want?: { readonly asset?: SpanRef; readonly amount?: SpanRef; readonly network?: SpanRef; readonly venue?: SpanRef };
  /** exit: the venue the money sits in now. */
  readonly position?: SpanRef;
  /** One network for the whole goal ("on base"). */
  readonly on?: SpanRef;
  readonly prefer?: SpanRef;
}

export interface Reading {
  readonly verdict: (typeof READING_VERDICTS)[number];
  readonly goal?: ReadingGoal;
  readonly unsure?: readonly string[];
}

const span = { type: "array", items: { type: "integer", minimum: 0, maximum: 64 }, minItems: 2, maxItems: 2 } as const;
const side = (keys: readonly string[]) => ({
  type: "object",
  additionalProperties: false,
  properties: Object.fromEntries(keys.map((key) => [key, span])),
});

/** JSON schema sent as the structured-output format. */
export const READING_JSON_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["verdict"],
  properties: {
    verdict: { type: "string", enum: [...READING_VERDICTS] },
    goal: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "verb"],
      properties: {
        kind: { type: "string", enum: [...READING_KINDS] },
        op: { type: "string", enum: [...READING_OPS] },
        verb: span,
        spend: side(["asset", "amount", "network"]),
        want: side(["asset", "amount", "network", "venue"]),
        position: span,
        on: span,
        prefer: span,
      },
    },
    unsure: { type: "array", items: { type: "string", maxLength: 32 }, maxItems: 8 },
  },
});

/** The answer schema of T3 (one option id of the open question, or none). */
export const ANSWER_JSON_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["option"],
  properties: { option: { type: ["string", "null"], maxLength: 64 }, evidence: span },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function spanOf(value: unknown, length: number): SpanRef | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [start, end] = value as unknown[];
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if ((start as number) < 0 || (end as number) > length || (start as number) >= (end as number)) return null;
  return [start as number, end as number];
}

function sideOf(value: unknown, keys: readonly string[], length: number): Record<string, SpanRef> | null {
  if (value === undefined) return {};
  if (!isRecord(value) || !onlyKeys(value, keys)) return null;
  const out: Record<string, SpanRef> = {};
  for (const key of keys) {
    if (value[key] === undefined) continue;
    const ref = spanOf(value[key], length);
    if (!ref) return null;
    out[key] = ref;
  }
  return out;
}

/** Parses a provider's text strictly; null for anything that is not exactly a reading over `length` tokens. */
export function parseReading(text: string, length: number): Reading | null {
  if (typeof text !== "string" || text.length === 0 || text.length > 4_000) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value) || !onlyKeys(value, ["verdict", "goal", "unsure"])) return null;
  if (!(READING_VERDICTS as readonly unknown[]).includes(value.verdict)) return null;
  let unsure: string[] | undefined;
  if (value.unsure !== undefined) {
    if (!Array.isArray(value.unsure) || value.unsure.length > 8 || !value.unsure.every((entry) => typeof entry === "string" && entry.length <= 32)) return null;
    unsure = value.unsure as string[];
  }
  if (value.goal === undefined) return { verdict: value.verdict as Reading["verdict"], ...(unsure ? { unsure } : {}) };
  const goal = value.goal;
  if (!isRecord(goal) || !onlyKeys(goal, ["kind", "op", "verb", "spend", "want", "position", "on", "prefer"])) return null;
  if (!(READING_KINDS as readonly unknown[]).includes(goal.kind)) return null;
  if (goal.op !== undefined && !(READING_OPS as readonly unknown[]).includes(goal.op)) return null;
  const verb = spanOf(goal.verb, length);
  if (!verb) return null;
  const spend = sideOf(goal.spend, ["asset", "amount", "network"], length);
  const want = sideOf(goal.want, ["asset", "amount", "network", "venue"], length);
  if (!spend || !want) return null;
  const optional: Record<string, SpanRef> = {};
  for (const key of ["position", "on", "prefer"] as const) {
    if (goal[key] === undefined) continue;
    const ref = spanOf(goal[key], length);
    if (!ref) return null;
    optional[key] = ref;
  }
  return {
    verdict: value.verdict as Reading["verdict"],
    goal: {
      kind: goal.kind as ReadingKind,
      ...(goal.op !== undefined ? { op: goal.op as ReadingOp } : {}),
      verb,
      ...(Object.keys(spend).length > 0 ? { spend } : {}),
      ...(Object.keys(want).length > 0 ? { want } : {}),
      ...optional,
    },
    ...(unsure ? { unsure } : {}),
  };
}

/** Parses a T3 answer: an option id among `ids`, or null. Undefined for a malformed answer. */
export function parseAnswer(text: string, ids: readonly string[], length: number): { option: string | null; evidence?: SpanRef } | undefined {
  if (typeof text !== "string" || text.length > 1_000) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || !onlyKeys(value, ["option", "evidence"])) return undefined;
  if (value.option === null) return { option: null };
  if (typeof value.option !== "string" || !ids.includes(value.option)) return undefined;
  const evidence = spanOf(value.evidence, length);
  if (!evidence) return undefined;
  return { option: value.option, evidence };
}
