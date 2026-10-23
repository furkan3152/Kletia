/**
 * The deterministic gates of a model reading (design A.7.3). A reading is a
 * proposal of structure only: which of Kletia's own tokens is spent, wanted,
 * where and how. Every value of the resulting Goal is taken from the lexer
 * token the evidence span cites, never from the provider's text. Any failed
 * gate rejects the reading (the deterministic refusal stands).
 *
 * Gates, in order: verdict and unsure; span shape and coverage of every word;
 * one span, one field; grounding of each field in its tokens; the two-sided,
 * verb-aware side gate; network attachment by connector; verb class; portion
 * evidence; output limits (the person only, no `max` into a venue); the Goal
 * validator. Agreement between families is checked by the caller.
 */
import { validateGoals, type AmountSel, type Goal, type NetworkKey, type Place, type ProtocolId } from "@kletia/core";
import type { Token } from "../goal/lexer.js";
import type { VerbEntry } from "../goal/lexicon.js";
import { READING_FILLERS } from "./egressWords.js";
import type { MaskedClause, MaskedToken } from "./mask.js";
import type { Reading, ReadingGoal, SpanRef } from "./schema.js";

export type GateCode =
  | "verdict"
  | "unsure"
  | "span"
  | "overlap"
  | "coverage"
  | "verb"
  | "verb_class"
  | "asset"
  | "side"
  | "amount"
  | "portion"
  | "network"
  | "venue"
  | "prefer"
  | "structure"
  | "output_limit"
  | "invalid_goal";

export type GateOutcome = { readonly ok: true; readonly goal: Goal } | { readonly ok: false; readonly code: GateCode };

const fail = (code: GateCode): GateOutcome => ({ ok: false, code });

/** Verbs that may come before the main verb ("i want to swap"): intent words only. */
const INTENT_PREFIX = new Set(["i want", "want", "i'd like", "id like", "i need", "need"]);
const SPEND_CONNECTORS = new Set(["from", "with", "using"]);
const WANT_CONNECTORS = new Set(["to", "into", "onto", "for", "as"]);
const VENUE_CONNECTORS = new Set(["into", "in", "on", "with", "at", "to", "via"]);
const POSITION_CONNECTORS = new Set(["from", "out of", "in", "on", "at"]);
/** Tokens a span may carry around its grounded token. */
const LEAD = new Set(["POSS", "DET"]);

type Kinded<T extends Token["t"]> = Extract<Token, { t: T }>;

interface Spans {
  readonly name: string;
  readonly span: SpanRef;
}

function spansOf(goal: ReadingGoal): Spans[] {
  const out: Spans[] = [{ name: "verb", span: goal.verb }];
  for (const [side, value] of [["spend", goal.spend], ["want", goal.want]] as const) {
    for (const [key, span] of Object.entries(value ?? {})) out.push({ name: `${side}.${key}`, span: span as SpanRef });
  }
  for (const key of ["position", "on", "prefer"] as const) if (goal[key]) out.push({ name: key, span: goal[key] as SpanRef });
  return out;
}

function slice(masked: MaskedClause, span: SpanRef): MaskedToken[] {
  return masked.tokens.slice(span[0], span[1]);
}

/** The single token of type `t` in a span, with only the allowed lead tokens around it; null otherwise. */
function single<T extends Token["t"]>(tokens: readonly MaskedToken[], t: T, connectors?: ReadonlySet<string>): { token: Kinded<T>; at: number; connector?: string } | null {
  let found: { token: Kinded<T>; at: number } | null = null;
  let connector: string | undefined;
  for (const [position, entry] of tokens.entries()) {
    const token = entry.token;
    if (token.t === t) {
      if (found) return null;
      found = { token: token as Kinded<T>, at: entry.i };
      continue;
    }
    if (found) return null; // nothing after the grounded token
    if (token.t === "CONN" && connectors && position === 0) {
      if (!connectors.has(token.word)) return null;
      connector = token.word;
      continue;
    }
    if (LEAD.has(token.t)) continue;
    return null;
  }
  return found ? { ...found, ...(connector ? { connector } : {}) } : null;
}

/** The index of the token before `index`, skipping possessives, determiners and amounts (the direct-object walk). */
function objectHead(masked: MaskedClause, index: number): MaskedToken | null {
  for (let at = index - 1; at >= 0; at -= 1) {
    const entry = masked.tokens[at] as MaskedToken;
    if (entry.token.t === "POSS" || entry.token.t === "DET" || entry.token.t === "AMOUNT") continue;
    return entry;
  }
  return null;
}

function protocol(value: string | undefined): ProtocolId | null {
  return value ? (value as ProtocolId) : null;
}

/**
 * Applies every gate to one parsed reading over its masked clause; the Goal
 * (confidence "llm", the person as holder) or the first failed gate's code.
 */
export function gateReading(reading: Reading, masked: MaskedClause): GateOutcome {
  if (reading.verdict !== "reading" || !reading.goal) return fail("verdict");
  if ((reading.unsure ?? []).length > 0) return fail("unsure");
  const goal = reading.goal;
  const length = masked.tokens.length;

  // Spans: well formed, at most 4 tokens, never overlapping (one span, one field).
  const spans = spansOf(goal);
  const owner = new Array<string | null>(length).fill(null);
  for (const { name, span } of spans) {
    if (span[0] < 0 || span[1] > length || span[0] >= span[1] || span[1] - span[0] > 4) return fail("span");
    for (let at = span[0]; at < span[1]; at += 1) {
      if (owner[at] !== null) return fail("overlap");
      owner[at] = name;
    }
  }
  // Coverage: every token lies in a span or is a reviewed filler.
  for (const entry of masked.tokens) {
    if (owner[entry.i] !== null) continue;
    if (entry.token.t === "DET" || (entry.token.t === "NOISE" && READING_FILLERS.has(entry.sent))) continue;
    return fail("coverage");
  }

  // Verb: verb tokens only (an intent prefix and "to" before the main verb); kind and op from the lexicon entry.
  const verbTokens = slice(masked, goal.verb);
  const verbs = verbTokens.filter((entry) => entry.token.t === "VERB");
  if (verbs.length === 0 || verbTokens.some((entry) => entry.token.t !== "VERB" && !(entry.token.t === "CONN" && entry.token.word === "to"))) return fail("verb");
  const main = verbs[verbs.length - 1] as MaskedToken;
  if (verbs.slice(0, -1).some((entry) => !INTENT_PREFIX.has(entry.sent))) return fail("verb");
  if (goal.verb[1] - 1 !== main.i) return fail("verb");
  const entry = (main.token as Kinded<"VERB">).verb as VerbEntry;
  if (entry.kind !== goal.kind || entry.op !== goal.op || entry.needsWork || entry.whole && goal.kind !== "exit") return fail("verb_class");
  // Every verb of the clause is in the verb span (coverage already makes other spans refuse a VERB).

  // Assets with the side gate.
  const assetOf = (side: "spend" | "want") => {
    const span = goal[side]?.asset;
    if (!span) return { ok: true as const, value: null };
    const found = single(slice(masked, span), "ASSET", side === "spend" ? SPEND_CONNECTORS : WANT_CONNECTORS);
    if (!found) return { ok: false as const, code: "asset" as GateCode };
    const head = objectHead(masked, span[0]);
    const direct = !found.connector && head?.i === main.i && entry.object === side;
    if (!found.connector && !direct) return { ok: false as const, code: "side" as GateCode };
    return { ok: true as const, value: found };
  };
  const spendAsset = assetOf("spend");
  if (!spendAsset.ok) return fail(spendAsset.code);
  const wantAsset = assetOf("want");
  if (!wantAsset.ok) return fail(wantAsset.code);

  // Amounts: one lexer amount right before its side's asset.
  const amountOf = (side: "spend" | "want", asset: { at: number } | null): { ok: true; value: AmountSel | null } | { ok: false; code: GateCode } => {
    const span = goal[side]?.amount;
    if (!span) return { ok: true, value: null };
    const found = single(slice(masked, span), "AMOUNT");
    if (!found || !asset) return { ok: false, code: "amount" };
    const assetSpan = goal[side]?.asset as SpanRef;
    if (span[1] !== assetSpan[0] || assetSpan[0] !== asset.at) return { ok: false, code: "amount" };
    const sel = found.token.sel;
    if (sel.t === "portion" && !slice(masked, span).some((item) => item.token.t === "POSS")) return { ok: false, code: "portion" };
    if (sel.t !== "exact" && sel.t !== "max" && sel.t !== "portion") return { ok: false, code: "amount" };
    return { ok: true, value: sel };
  };
  const spendAmount = amountOf("spend", spendAsset.value);
  if (!spendAmount.ok) return fail(spendAmount.code);
  const wantAmount = amountOf("want", wantAsset.value);
  if (!wantAmount.ok) return fail(wantAmount.code);

  // Networks: attached by their connector ("from X" spend, "to X" want, "on X" the whole goal).
  const networkOf = (span: SpanRef | undefined, connectors: ReadonlySet<string>) => {
    if (!span) return { ok: true as const, value: null };
    const tokens = slice(masked, span);
    const found = single(tokens, "NETWORK", connectors);
    if (!found || !found.connector || tokens.length !== 2) return { ok: false as const };
    return { ok: true as const, value: found.token.network };
  };
  const fromNet = networkOf(goal.spend?.network, new Set(["from"]));
  const toNet = networkOf(goal.want?.network, new Set(["to", "into", "onto"]));
  const onNet = networkOf(goal.on, new Set(["on", "in"]));
  if (!fromNet.ok || !toNet.ok || !onNet.ok) return fail("network");

  // Venues.
  let venue: ProtocolId | null = null;
  if (goal.want?.venue) {
    const found = single(slice(masked, goal.want.venue), "VENUE", VENUE_CONNECTORS);
    if (!found) return fail("venue");
    venue = protocol(goal.op === "stake" ? found.token.venue.provider : found.token.venue.lending);
    if (!venue) return fail("venue");
  }
  let position: ProtocolId | null = null;
  if (goal.position) {
    const tokens = slice(masked, goal.position).filter((item) => item.token.t !== "POSITION");
    const found = single(tokens, "VENUE", POSITION_CONNECTORS);
    if (!found) return fail("venue");
    position = protocol(found.token.venue.lending ?? found.token.venue.provider);
    if (!position) return fail("venue");
  }
  let prefer: "cheapest" | "fastest" | "safest" | null = null;
  if (goal.prefer) {
    const tokens = slice(masked, goal.prefer);
    const only = tokens.length === 1 ? tokens[0]?.token : undefined;
    if (!only || only.t !== "PREFER") return fail("prefer");
    prefer = only.prefer;
  }

  // Structure per kind (verb class, output limits).
  const spendSym = spendAsset.value?.token.symbol ?? null;
  const wantSym = wantAsset.value?.token.symbol ?? null;
  const wallet = (network: NetworkKey | null): Place | undefined => (network ? { network, custody: { kind: "wallet" } } : undefined);
  const net = (value: { value: NetworkKey | null }) => value.value;
  let built: Goal;
  switch (goal.kind) {
    case "convert":
    case "acquire": {
      if (!wantSym || venue || position) return fail("structure");
      if (goal.kind === "convert" && !spendSym) return fail("structure");
      if (spendSym && spendSym.toLowerCase() === wantSym.toLowerCase()) return fail("structure");
      if (wantAmount.value && (spendAmount.value || !(entry.object === "want" || entry.buy))) return fail("amount");
      if (onNet.value && (fromNet.value || toNet.value)) return fail("network");
      const fromNetwork = net(fromNet) ?? net(onNet);
      const toNetwork = net(toNet) ?? net(onNet);
      const from = wallet(fromNetwork);
      const at = wallet(toNetwork);
      built = {
        kind: goal.kind,
        ...(goal.op ? { op: goal.op } : {}),
        spend: { ...(spendSym ? { asset: { symbol: spendSym } } : {}), ...(spendAmount.value ? { amount: spendAmount.value } : {}), ...(from ? { from } : {}) },
        want: { asset: { symbol: wantSym }, ...(wantAmount.value ? { amount: wantAmount.value } : {}), ...(at ? { at } : {}) },
        holder: { t: "self" },
        constraints: prefer ? { prefer } : {},
        confidence: "llm",
      };
      break;
    }
    case "relocate": {
      if (!spendSym || wantSym || wantAmount.value || venue || position || onNet.value || !toNet.value) return fail("structure");
      if (fromNet.value === toNet.value) return fail("network");
      const from = wallet(net(fromNet));
      built = {
        kind: "relocate",
        ...(goal.op ? { op: goal.op } : {}),
        spend: { asset: { symbol: spendSym }, ...(spendAmount.value ? { amount: spendAmount.value } : {}), ...(from ? { from } : {}) },
        want: { at: wallet(toNet.value) as Place },
        holder: { t: "self" },
        constraints: prefer ? { prefer } : {},
        confidence: "llm",
      };
      break;
    }
    case "earn": {
      if (!spendSym || wantSym || wantAmount.value || position || fromNet.value || toNet.value || !venue) return fail("structure");
      // Output limits: never "everything" or "all but" into a venue.
      if (spendAmount.value && spendAmount.value.t !== "exact" && spendAmount.value.t !== "portion") return fail("output_limit");
      const network = net(onNet);
      built = {
        kind: "earn",
        ...(goal.op ? { op: goal.op } : {}),
        spend: { asset: { symbol: spendSym }, ...(spendAmount.value ? { amount: spendAmount.value } : {}), ...(network ? { from: wallet(network) as Place } : {}) },
        want: { at: { ...(network ? { network: network } : {}), custody: { kind: "venue", protocol: venue } } as Place },
        holder: { t: "self" },
        constraints: prefer ? { prefer } : {},
        confidence: "llm",
      };
      break;
    }
    case "exit": {
      if (!position || wantSym || wantAmount.value || venue || fromNet.value || toNet.value) return fail("structure");
      const network = net(onNet);
      built = {
        kind: "exit",
        ...(goal.op ? { op: goal.op } : {}),
        spend: {
          ...(spendSym ? { asset: { symbol: spendSym } } : {}),
          ...(spendAmount.value ? { amount: spendAmount.value } : {}),
          from: { ...(network ? { network: network } : {}), custody: { kind: "position", protocol: position } } as Place,
        },
        want: {},
        holder: { t: "self" },
        constraints: prefer ? { prefer } : {},
        confidence: "llm",
      };
      break;
    }
    default:
      return fail("structure");
  }
  const checked = validateGoals([built]);
  if (!checked.ok) return fail("invalid_goal");
  return { ok: true, goal: built };
}

/** Canonical JSON (sorted keys): two readings agree when these strings are equal. */
export function canonicalGoal(goal: Goal): string {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort);
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value as object).sort().map((key) => [key, sort((value as Record<string, unknown>)[key])]));
    return value;
  };
  return JSON.stringify(sort(goal));
}
