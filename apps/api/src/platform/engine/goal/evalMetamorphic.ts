/**
 * The metamorphic suite: for every ready prompt of a corpus (a hand-off acts as
 * a corpus, seeded variants of its text whose correct outcome follows from
 * original's, so the corpora's own phrasings cannot hide a reader that ignores
 * a word. Relations:
 *
 * 1. a never-drop word inserted at the start, after the verb or at the end:
 *    never ready;
 * 2. a unit word inserted after the amount: never the same plan;
 * 3. the two assets swapped: the direction flips, or it asks;
 * 4. the two recipients swapped: they swap in the plan, or it asks;
 * 5. a network word replaced by an unsupported network or given a lane
 *    qualifier: never ready (the target refusal is NETWORK_UNSUPPORTED);
 * 6. "?" appended: never ready;
 * 7. a reviewed filler inserted: the identical plan, or not ready;
 * 8. a symbol replaced by an unlisted look-alike: never ready;
 * 9. a network word replaced by a one-edit English word ("case"): never ready.
 *
 * A violation is a wrong or unsafe outcome and gates the merge (ledgered
 * with the package that clears it while one exists). A gap is a safe
 * outcome short of the target (a refusal with another code, a filler that is
 * not read yet) and is only reported. Deterministic: the variants of a
 * prompt depend on its id and the seed only.
 */
import { LOOKALIKE_FAMILIES, isKnownSymbol, type NetworkKey } from "@kletia/core";
import type { Corpus } from "../clarify/corpusHarness.js";
import { recipientsSaid } from "./evalOracle.js";
import { runIntentEval, type EvalResult, type IntentEvalCorpus, type IntentEvalPrompt, type RunOptions } from "./evalHarness.js";
import type { MetamorphicAllowance } from "./evalTransitions.js";

export const METAMORPHIC_RELATIONS = Object.freeze([
  "never-drop", "unit", "asset-swap", "recipient-swap", "unsupported-network", "question-mark", "filler", "look-alike", "english-network",
] as const);
export type MetamorphicRelation = (typeof METAMORPHIC_RELATIONS)[number];

/** At most this many variants per prompt. */
export const MAX_VARIANTS_PER_PROMPT = 20;

export interface MetamorphicVariant {
  /** "<prompt id>~<relation>~<n>". */
  readonly id: string;
  readonly of: string;
  readonly relation: MetamorphicRelation;
  readonly say: string;
  /** What was changed, for the report. */
  readonly change: string;
}

/** mulberry32 over a string hash: the same id and seed always give the same sequence. */
function rng(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i += 1) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let state = h >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(random: () => number, list: readonly T[], count: number): T[] {
  const pool = [...list];
  const out: T[] = [];
  while (out.length < count && pool.length > 0) out.push(pool.splice(Math.floor(random() * pool.length), 1)[0] as T);
  return out;
}

/** Never-drop insertions (relation 1): the phrase and where it goes. */
const NEVER_DROP_INSERTS: readonly { readonly phrase: string; readonly at: "start" | "verb" | "end" }[] = [
  { phrase: "dont", at: "start" },
  { phrase: "do not", at: "start" },
  { phrase: "not", at: "verb" },
  { phrase: "never", at: "start" },
  { phrase: "never mind,", at: "start" },
  { phrase: "cancel that,", at: "start" },
  { phrase: "should i", at: "start" },
  { phrase: "what if i", at: "start" },
  { phrase: "maybe", at: "verb" },
  { phrase: "idk", at: "start" },
  { phrase: "tomorrow", at: "end" },
  { phrase: "every day", at: "end" },
  { phrase: "if eth goes up", at: "end" },
  { phrase: "unless fees are high", at: "end" },
  { phrase: "later", at: "end" },
  { phrase: "or not", at: "end" },
  { phrase: "or usdt", at: "end" },
  { phrase: "either", at: "verb" },
  { phrase: "up to", at: "verb" },
  { phrase: "at most", at: "verb" },
  { phrase: "over", at: "verb" },
  { phrase: "about", at: "verb" },
  { phrase: "around", at: "verb" },
];

const UNIT_INSERTS: readonly string[] = ["k", "million", "cents", "thousand"];
const FILLER_INSERTS: readonly { readonly phrase: string; readonly at: "start" | "end" }[] = [
  { phrase: "pls", at: "end" },
  { phrase: "please", at: "start" },
  { phrase: "thanks", at: "end" },
  { phrase: "lol", at: "end" },
  { phrase: "rn", at: "end" },
  { phrase: "gm", at: "start" },
  { phrase: "kindly", at: "start" },
];
const UNSUPPORTED_REPLACEMENTS: readonly string[] = ["arbitrum nova", "linea", "bsc", "zksync", "avalanche", "scroll"];
const QUALIFIERS: Readonly<Partial<Record<NetworkKey, string>>> = { base: "sepolia", ethereum: "goerli", optimism: "sepolia", polygon: "testnet", solana: "testnet", arbitrum: "nova" };
const NETWORK_SPELLINGS: Readonly<Record<string, NetworkKey>> = {
  base: "base", arbitrum: "arbitrum", arb: "arbitrum", ethereum: "ethereum", optimism: "optimism", op: "optimism", polygon: "polygon", solana: "solana",
};
const ENGLISH_NEIGHBOURS: readonly string[] = ["case", "vase", "bass", "bake"];
/** Listed symbols and the unlisted look-alike that replaces them (relation 8). */
const LOOKALIKE_SWAPS: Readonly<Record<string, string>> = (() => {
  const out: Record<string, string> = {};
  for (const family of LOOKALIKE_FAMILIES) {
    const unlisted = family.members.filter((member) => !isKnownSymbol(member) && !/\s/u.test(member));
    if (unlisted.length === 0) continue;
    for (const member of family.members) if (isKnownSymbol(member)) out[member.toLowerCase()] = (unlisted[0] as string).toLowerCase();
  }
  out.eth = "steth";
  out.sol = "wsol";
  out.usdc = "usdc.e";
  return out;
})();

const VERB = /^(\s*)(\w+)/u;
const FIRST_AMOUNT = /(?<![\w.$])(\d+(?:\.\d+)?)(?=\s+[a-z$])/iu;

function insertAt(say: string, phrase: string, at: "start" | "verb" | "end"): string | null {
  if (at === "start") return `${phrase} ${say}`;
  if (at === "end") return `${say.replace(/[.!\s]+$/u, "")} ${phrase}`;
  const verb = VERB.exec(say);
  if (!verb) return null;
  const end = (verb.index ?? 0) + verb[0].length;
  return `${say.slice(0, end)} ${phrase}${say.slice(end)}`;
}

function wordPositions(say: string, word: string): number[] {
  const out: number[] = [];
  const pattern = new RegExp(`(?<![\\w.$])${word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?![\\w])`, "giu");
  for (const match of say.matchAll(pattern)) out.push(match.index ?? 0);
  return out;
}

/** The variants of one ready prompt (at most MAX_VARIANTS_PER_PROMPT), deterministic in its id and the seed. */
export function metamorphicVariants(prompt: IntentEvalPrompt, result: EvalResult, seed = "kletia-metamorphic-v1"): MetamorphicVariant[] {
  if (result.status !== "ready" || !result.plan) return [];
  const random = rng(`${seed}|${prompt.id}`);
  const say = prompt.say;
  const out: MetamorphicVariant[] = [];
  const push = (relation: MetamorphicRelation, text: string | null, change: string) => {
    if (!text || text === say || out.length >= MAX_VARIANTS_PER_PROMPT) return;
    out.push({ id: `${prompt.id}~${relation}~${out.filter((variant) => variant.relation === relation).length + 1}`, of: prompt.id, relation, say: text, change });
  };
  // 1. never-drop words
  for (const insert of pick(random, NEVER_DROP_INSERTS, 7)) push("never-drop", insertAt(say, insert.phrase, insert.at), `+"${insert.phrase}" at ${insert.at}`);
  // 2. a unit word after the amount
  const amount = FIRST_AMOUNT.exec(say);
  if (amount) {
    const unit = pick(random, UNIT_INSERTS, 1)[0] as string;
    const end = (amount.index ?? 0) + amount[0].length;
    push("unit", `${say.slice(0, end)} ${unit}${say.slice(end)}`, `+"${unit}" after ${amount[1]}`);
  }
  // 3. the two assets swapped (one-step swaps whose symbols are both typed once)
  const step = /^swap@\S+ \S+ (\S+)->(\S+?)(?: |$)/u.exec(result.plan);
  if (step && !result.plan.includes(" | ")) {
    const [from, to] = [step[1] as string, step[2] as string];
    const a = wordPositions(say, from);
    const b = wordPositions(say, to);
    if (a.length === 1 && b.length === 1) {
      const swapped = say.replace(new RegExp(`(?<![\\w.$])(${from}|${to})(?![\\w])`, "giu"), (word) => (word.toLowerCase() === from.toLowerCase() ? to.toLowerCase() : from.toLowerCase()));
      push("asset-swap", swapped, `${from}<->${to}`);
    }
  }
  // 4. two recipients swapped
  const recipients = recipientsSaid(say);
  if (recipients.length === 2) {
    const [r1, r2] = recipients as [string, string];
    const swapped = say.replace(new RegExp(`${r1.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}|${r2.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "giu"), (word) => (word.toLowerCase() === r1 ? r2 : r1));
    push("recipient-swap", swapped, `${r1}<->${r2}`);
  }
  // 5. a network word replaced by an unsupported network, or given a lane qualifier
  const networkMatch = /\b(on|from|to|onto)\s+(base|arbitrum|arb|ethereum|optimism|op|polygon|solana)\b/iu.exec(say);
  if (networkMatch) {
    const start = (networkMatch.index ?? 0) + (networkMatch[1] as string).length + 1;
    const word = networkMatch[2] as string;
    const replacement = pick(random, UNSUPPORTED_REPLACEMENTS, 1)[0] as string;
    push("unsupported-network", `${say.slice(0, start)}${replacement}${say.slice(start + word.length)}`, `${word} -> ${replacement}`);
    const qualifier = QUALIFIERS[NETWORK_SPELLINGS[word.toLowerCase()] as NetworkKey];
    if (qualifier) push("unsupported-network", `${say.slice(0, start + word.length)} ${qualifier}${say.slice(start + word.length)}`, `${word} + ${qualifier}`);
  }
  // 6. a question mark
  push("question-mark", `${say.replace(/[.!\s]+$/u, "")}?`, `+"?"`);
  // 7. reviewed fillers
  for (const insert of pick(random, FILLER_INSERTS, 2)) push("filler", insertAt(say, insert.phrase, insert.at), `+"${insert.phrase}" at ${insert.at}`);
  // 8. a symbol replaced by an unlisted look-alike
  const symbols = Object.keys(LOOKALIKE_SWAPS).filter((symbol) => wordPositions(say, symbol).length > 0);
  const symbol = pick(random, symbols, 1)[0];
  if (symbol) {
    const position = wordPositions(say, symbol)[0] as number;
    push("look-alike", `${say.slice(0, position)}${LOOKALIKE_SWAPS[symbol]}${say.slice(position + symbol.length)}`, `${symbol} -> ${LOOKALIKE_SWAPS[symbol]}`);
  }
  // 9. "base" as a network replaced by a one-edit English word
  const base = /\b(on|from|to|onto)\s+(base)\b/iu.exec(say);
  if (base) {
    const start = (base.index ?? 0) + (base[1] as string).length + 1;
    const neighbour = pick(random, ENGLISH_NEIGHBOURS, 1)[0] as string;
    push("english-network", `${say.slice(0, start)}${neighbour}${say.slice(start + 4)}`, `base -> ${neighbour}`);
  }
  return out;
}

export interface MetamorphicFinding {
  readonly variant: MetamorphicVariant;
  readonly original: string;
  readonly got: string;
  readonly kind: "violation" | "gap";
  readonly reason: string;
}

function gotOf(result: EvalResult): string {
  return result.status === "ready" ? result.plan ?? "" : result.status === "needs_input" ? `[${result.questions[0] ?? ""}]` : `${result.status}:${result.error ?? ""}`;
}

/** Judges one variant's result against the original's (the relations above). */
export function judgeVariant(variant: MetamorphicVariant, original: EvalResult, result: EvalResult): MetamorphicFinding | null {
  const got = gotOf(result);
  const finding = (kind: "violation" | "gap", reason: string): MetamorphicFinding => ({ variant, original: original.plan ?? "", got, kind, reason });
  if (result.status === "crashed") return finding("violation", "crashed");
  const ready = result.status === "ready";
  switch (variant.relation) {
    case "never-drop":
    case "question-mark":
    case "look-alike":
    case "english-network":
      return ready ? finding("violation", "stays ready") : null;
    case "unsupported-network":
      if (ready) return finding("violation", "stays ready");
      return result.status === "refused" && result.error !== "NETWORK_UNSUPPORTED" ? finding("gap", `refused with ${result.error ?? "?"}, target NETWORK_UNSUPPORTED`) : null;
    case "unit":
      return ready && result.plan === original.plan ? finding("violation", "the unit word is ignored") : null;
    case "asset-swap": {
      if (!ready) return null;
      const before = /^swap@\S+ \S+ (\S+)->(\S+?)(?: |$)/u.exec(original.plan ?? "");
      const after = /^swap@\S+ \S+ (\S+)->(\S+?)(?: |$)/u.exec(result.plan ?? "");
      if (before && after && before[1] === after[1] && before[2] === after[2]) return finding("violation", "the direction did not flip");
      return null;
    }
    case "recipient-swap": {
      if (!ready) return null;
      const [r1, r2] = recipientsSaid(variant.say);
      if (!r1 || !r2) return null;
      const expected = (original.plan ?? "").replace(new RegExp(`${r1.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}|${r2.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "giu"), (word) => (word.toLowerCase() === r1 ? r2 : r1));
      return result.plan?.toLowerCase() === expected.toLowerCase() ? null : finding("violation", `recipients not swapped (expected ${expected})`);
    }
    case "filler":
      if (ready && result.plan !== original.plan) return finding("violation", "a filler changed the plan");
      return ready ? null : finding("gap", "a reviewed filler is not read yet");
  }
}

export interface MetamorphicRun {
  readonly variants: number;
  readonly findings: readonly MetamorphicFinding[];
}

/**
 * Runs the suite over the ready prompts of one corpus (decide mode; the
 * caller passes the original results; originals that needed a confirm are
 * skipped). `limit` caps the prompts (a sample
 * for quick runs); all of them by default.
 */
export async function runMetamorphic(
  corpus: IntentEvalCorpus,
  fixtures: Corpus,
  originals: readonly EvalResult[],
  options: RunOptions & { readonly seed?: string; readonly limit?: number } = {},
): Promise<MetamorphicRun> {
  const byId = new Map(originals.map((result) => [result.id, result]));
  const variants: { variant: MetamorphicVariant; prompt: IntentEvalPrompt }[] = [];
  for (const prompt of corpus.prompts) {
    const original = byId.get(prompt.id);
    // Only plans that need no confirm: a confirm is already "not ready" for every relation.
    if (!original || original.status !== "ready" || original.confirmed) continue;
    for (const variant of metamorphicVariants(prompt, original, options.seed)) {
      variants.push({ variant, prompt: { ...prompt, id: variant.id, say: variant.say, then: undefined } as IntentEvalPrompt });
    }
    if (options.limit !== undefined && variants.length >= options.limit * MAX_VARIANTS_PER_PROMPT) break;
  }
  const generated: IntentEvalCorpus = { ...corpus, prompts: variants.map((entry) => entry.prompt) };
  // Variants run without the harness confirm: a confirm counts as not ready (relations 1, 6, 8, 9).
  const results = variants.length > 0 ? await runIntentEval(generated, fixtures, { ...options, mode: "decide", oracles: false, autoConfirm: false }) : [];
  const findings: MetamorphicFinding[] = [];
  results.forEach((result, index) => {
    const entry = variants[index] as (typeof variants)[number];
    const finding = judgeVariant(entry.variant, byId.get(entry.variant.of) as EvalResult, result);
    if (finding) findings.push(finding);
  });
  return { variants: variants.length, findings };
}

export function formatMetamorphic(corpusName: string, run: MetamorphicRun): string {
  const violations = run.findings.filter((finding) => finding.kind === "violation");
  const gaps = run.findings.filter((finding) => finding.kind === "gap");
  const lines = [`metamorphic ${corpusName}: ${run.variants} variants, ${violations.length} violations, ${gaps.length} gaps`];
  for (const finding of violations) lines.push(`  VIOLATION ${finding.variant.id} (${finding.variant.change}) ${JSON.stringify(finding.variant.say)} -> ${finding.got}: ${finding.reason}`);
  return lines.join("\n");
}

export interface MetamorphicCheck {
  /** Violations with no allowance: these fail. */
  readonly open: readonly MetamorphicFinding[];
  /** Violations an allowance covers. */
  readonly allowed: number;
  /** Allowances of this corpus no violation uses any more (remove them). */
  readonly stale: readonly MetamorphicAllowance[];
}

/** The id an allowance names for one variant: "<corpus>:<variant id>". */
export function metamorphicAllowanceId(corpusName: string, finding: MetamorphicFinding): string {
  return `${corpusName}:${finding.variant.id}`;
}

/** Checks a run's violations against the ledger's allowances for this corpus (gaps never fail). */
export function checkMetamorphic(corpusName: string, run: MetamorphicRun, allowances: readonly MetamorphicAllowance[]): MetamorphicCheck {
  const mine = allowances.filter((allow) => allow.id.startsWith(`${corpusName}:`));
  const used = new Set<string>();
  const open: MetamorphicFinding[] = [];
  let allowed = 0;
  for (const finding of run.findings) {
    if (finding.kind !== "violation") continue;
    const id = metamorphicAllowanceId(corpusName, finding);
    if (mine.some((allow) => allow.id === id)) {
      used.add(id);
      allowed += 1;
    } else {
      open.push(finding);
    }
  }
  return { open, allowed, stale: mine.filter((allow) => !used.has(allow.id)) };
}
