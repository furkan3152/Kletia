/**
 * Binding clauses to each other: vague clauses, refusals, chaining and
 * references to previous steps.
 */
import { SENTENCE_VERBS, type NetworkKey } from "@kletia/core";
import { PlatformError } from "../../../errors.js";
import {
  ASSET_NETWORK_WORDS,
  assetOrNetworkRefusal,
  NEUTRAL_MOVE_VERBS,
} from "../../grammar.js";
import {
  lex,
  normalizeClause,
  symbolTypoCandidates,
  type Token,
} from "../../goal/index.js";
import {
  canonicalOn,
  lane,
  NETWORK_ORDER,
  isUsdWord,
  knownSymbol,
  stakeProvider,
} from "../catalog.js";
import type { Kind, WorkStep } from "../types.js";
import type { ThreadCorrection } from "@kletia/core";
import { REFUSAL_EXAMPLES } from "./shapes.js";
import { slot } from "./clauses.js";

/* --------------------------------------------------------- "the rest" */

/**
 * "sell 1 sol, then stake the rest": the rest of the holding the step before
 * spent from, when this step can only take that token (a stake takes its
 * native token, never the stablecoin the sale produced). Every other "the
 * rest" after a step keeps its reading of the previous output, except a
 * payment to someone else, whose amount is asked (I13).
 */
export function bindRest(step: WorkStep, before: WorkStep | undefined, at: number): void {
  if (!before) return;
  if (paysSomeoneElse(step)) {
    delete step.amount;
    return;
  }
  const spent = before.from?.v.toUpperCase();
  const native = spent === "SOL" || spent === "ETH";
  if (step.kind?.v === "stake" && native && before.amount?.v.t === "exact" && before.amount.by === "user" && !paysSomeoneElse(before)) {
    const input = step.from?.v.toUpperCase() ?? (step.provider ? stakeProvider(step.provider.v)?.input : undefined) ?? spent;
    if (input !== spent) return;
    step.from = { v: spent, by: "derived", prov: { rule: "rest" } };
    step.amount = { v: { t: "balance", bps: 10_000 }, by: "derived", prov: { rule: "rest" } };
    step.keep = [{ amount: { t: "exact", value: before.amount.v.value }, asset: spent, ...(before.network && before.network.by === "user" ? { network: before.network.v } : {}) }];
    step.source = "C";
    step.readAs = [...(step.readAs ?? []), { slot: "amount", rule: "rest", to: `The rest of your ${spent} after step ${at}`.slice(0, 40) }].slice(0, 4);
  }
}

/** Nouns that name no asset ("swap some tokens", "stake something"). */
const VAGUE_NOUNS: ReadonlySet<string> = new Set([
  "stuff", "something", "anything", "token", "tokens", "coin", "coins", "crypto", "cryptos", "money", "funds", "cash", "assets",
]);
/** Words around them that add nothing ("some", "a bit of", "my", "please"). */
const VAGUE_WORDS: ReadonlySet<string> = new Set([...VAGUE_NOUNS, "some", "few", "bit", "little", "of", "my", "the", "a", "an", "me", "please"]);

/**
 * A clause that names an action but nothing it acts on ("swap", "swap some
 * tokens", "stake something"): the action alone, so the policy asks for what
 * is missing instead of refusing. Anything else in the clause (an unknown
 * word, a number) keeps it unread.
 */
export function vagueClause(clause: string, bare: boolean): WorkStep | null {
  const [verb = "", ...rest] = clause.toLowerCase().replace(/[.!?]+$/u, "").split(/\s+/u);
  if (!Object.hasOwn(SENTENCE_VERBS, verb)) return null;
  if (!rest.every((word) => VAGUE_WORDS.has(word))) return null;
  // Read first only when a vague noun stands where the asset would; a bare verb only when nothing else reads.
  if (!bare && !rest.some((word) => VAGUE_NOUNS.has(word))) return null;
  const kind = SENTENCE_VERBS[verb] as Kind;
  const step: WorkStep = { kind: slot(kind), vague: true };
  if (verb === "buy" || verb === "get" || verb === "purchase") step.buy = true;
  if (verb === "sell") step.sell = true;
  return step;
}

/** ASSET_TYPO (D9): an unknown symbol within one edit of listed symbols ("SLO" for SOL), flagged for the policy. */
/** "send alice.eth and bob.eth 10 and 20 usdc": recipients and amounts in separate lists. */
export const PARALLEL_LISTS = /^(?:send|pay|transfer|give|tip)\s+\S+\s+and\s+\S+\s+\$?[\d.,]+\s+and\s+\$?[\d.,]+(?:\s|$)/iu;

export function pairingRefusal(): PlatformError {
  return new PlatformError("INTENT_UNSUPPORTED", "Kletia does not pair recipients and amounts by their order. Give each recipient its amount, for example \"send 10 USDC to alice.eth and 20 USDC to bob.eth\".", 422,
    [{ path: "text", message: "Recipients and amounts are in separate lists." }], REFUSAL_EXAMPLES);
}

/** A name or an address read where a token goes ("send alice.eth ..."): the clause is not read as a payment of that "token". */
export function recipientAsToken(step: WorkStep): boolean {
  return [step.from?.v, step.to?.v].some((value) => value !== undefined && /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:eth|sns|sol)|0x[0-9a-f]{40})$/iu.test(value) && !knownSymbol(value));
}

export function flagAssetTypo(step: WorkStep): void {
  if (step.assetTypo) return;
  for (const field of ["from", "to"] as const) {
    const said = step[field];
    if (!said || said.by !== "user") continue;
    const found = symbolTypoCandidates(said.v);
    if (found.length > 0) {
      step.assetTypo = { field, raw: said.v.slice(0, 16), candidates: found };
      return;
    }
  }
}

/** Step kinds that spend the previous step's output when their clause names neither an amount nor an asset. */
const CHAINABLE: ReadonlySet<Kind> = new Set(["swap", "bridge", "transfer", "deposit", "stake"]);

/** A step whose output goes to someone else: a recipient, a nickname, any transfer, or a payment goal. */
export function paysSomeoneElse(step: WorkStep | undefined): boolean {
  if (!step) return false;
  if (step.recipient !== undefined || step.nickname === true || step.kind?.v === "transfer") return true;
  return step.kind === undefined && step.goal !== undefined && step.goal.holder.t !== "self";
}

/**
 * A step that spends what the step before it produced: "it", "that", "the
 * rest", "half of it", "all" after a step, or a goal chained to the one
 * before (a portion or "all" with no token named counts as chained).
 */
export function spendsPrevious(step: WorkStep): boolean {
  if (step.amount?.v.t === "previous") return true;
  const goal = step.kind === undefined ? step.goal : undefined;
  if (!goal) return false;
  if (goal.chain !== undefined || goal.spend.amount?.t === "previous") return true;
  return !goal.spend.asset && (goal.spend.amount?.t === "portion" || goal.spend.amount?.t === "max") && goal.spend.from?.custody.kind !== "position";
}

/**
 * "send 10 USDC to vitalik.eth on base and swap it to ETH": "it" would be the
 * money paid to someone else, which is no longer in the person's account.
 * Refused instead of spending other funds.
 */
export function previousPaidRefusal(at: number): PlatformError {
  const step = at > 0 ? `Step ${at + 1}` : "This step";
  const before = at > 0 ? `step ${at}` : "the step before";
  return new PlatformError(
    "INTENT_UNSUPPORTED",
    `${step} spends what ${before} produces, but ${before} pays someone else, so that money is no longer in your account. ` +
      `Give ${step.toLowerCase()} its own amount and token, for example "send 10 USDC to vitalik.eth on base, then swap 5 USDC to ETH on base".`,
    422,
    [{ path: `actions[${at}].amount`, message: "The previous step pays someone else." }],
    REFUSAL_EXAMPLES,
  );
}

/**
 * "move 10 USDC to op", "send 10 USDC to sol": a neutral verb whose
 * destination names both a token and a network, with no source network said
 * ("from base") and no "as <token>": refused with both phrasings instead of
 * choosing a bridge or a swap.
 */
export function neutralDestination(clause: string): PlatformError | null {
  const tokens = lex(normalizeClause(clause));
  // One verb's span at a time: a source said anywhere in it ("to op from base") keeps the network reading.
  const starts = tokens.flatMap((token, position) => (token.t === "VERB" ? [position] : []));
  for (const [order, start] of starts.entries()) {
    const span = tokens.slice(start, starts[order + 1] ?? tokens.length);
    const verb = (span[0] as Extract<Token, { t: "VERB" }>).raw.toLowerCase();
    if (!NEUTRAL_MOVE_VERBS.includes(verb)) continue;
    const source = span.some((token, position) => {
      const next = span[position + 1];
      return token.t === "CONN" && token.word === "from" && (next?.t === "NETWORK" || (next?.t === "ASSET" && next.network !== undefined));
    });
    if (source) continue;
    for (const [position, token] of span.entries()) {
      if (token.t !== "CONN" || (token.word !== "to" && token.word !== "into" && token.word !== "onto")) continue;
      const next = span[position + 1];
      if (next?.t !== "ASSET" || !next.network || !Object.hasOwn(ASSET_NETWORK_WORDS, next.raw.toLowerCase())) continue;
      const after = span[position + 2];
      // "to sol as SOL" names the token after the network; "to sol network" names the network.
      if (after?.t === "CONN" && after.word === "as") continue;
      if (after?.t === "NOISE" && /^(?:network|chain)$/iu.test(after.raw)) continue;
      const amount = span.find((entry): entry is Extract<Token, { t: "AMOUNT" }> => entry.t === "AMOUNT" && entry.sel.t === "exact");
      const asset = span.find((entry, at): entry is Extract<Token, { t: "ASSET" }> => entry.t === "ASSET" && at < position);
      return assetOrNetworkRefusal(clause, verb, next.raw, amount && asset ? `${amount.raw} ${asset.symbol.toUpperCase()}` : undefined);
    }
  }
  return null;
}

/**
 * "swap 1 SOL to USDC, bridge to base, deposit into aave": a later clause with
 * no amount and no asset continues with what the step before produced, as if
 * it said "it" (F9). Stake's derived input (SOL) counts as unsaid. Never after
 * a step that pays someone else: that output is not the person's to spend
 * (the step then asks for its amount).
 */
export function chainImplicit(step: WorkStep, previous: boolean, before?: WorkStep): void {
  if (!previous || step.amount || step.usdFrom || step.contract || step.goal) return;
  if (paysSomeoneElse(before)) return;
  if (!step.kind || !CHAINABLE.has(step.kind.v)) return;
  if (step.from && step.from.by === "user") return;
  if (step.kind.v === "stake" && step.from) delete step.from;
  step.amount = slot({ t: "previous", bps: 10_000 }, "derived");
}

/** The token a step leaves in the person's account, when the step says it (never for payments, stakes or deposits). */
export function outputOf(step: WorkStep): string | undefined {
  if (step.goal && !step.kind) return undefined;
  switch (step.kind?.v) {
    case "swap":
      return step.to?.v;
    case "bridge":
      return step.to?.v ?? step.from?.v;
    case "withdraw":
      return step.from?.v;
    default:
      return undefined;
  }
}

/** Where a step's output lands, when the message says it (or the spent token has one home network). */
export function destinationOf(step: WorkStep): NetworkKey | undefined {
  if (step.kind?.v === "bridge") return step.toNetwork?.v;
  if (step.network && step.network.by !== "assumed") return step.network.v;
  const spent = step.from?.v;
  if (!spent || step.kind?.v !== "swap") return undefined;
  const homes = NETWORK_ORDER.filter((network) => lane(network) === "mainnet" && canonicalOn(network, spent) !== null);
  return homes.length === 1 ? homes[0] : undefined;
}

/**
 * "send 20 of it to carol.sns" spends exactly 20 of the previous step's output
 * token, where that output lands. Bound only when the message names both the
 * token and the network the output lands on; otherwise the step stays without a
 * token and the policy asks for it.
 */
export function bindOfPrevious(step: WorkStep, before: WorkStep | undefined, at: number): void {
  if (!before || step.usdFrom || step.amount?.v.t !== "exact") return;
  const asset = outputOf(before);
  const landing = destinationOf(before);
  if (step.from) {
    // "send 10 usdc of it" after a step that delivers another token: "it" is not what the step names.
    if (asset && step.from.v.toUpperCase() !== asset.toUpperCase()) {
      throw new PlatformError("INTENT_UNSUPPORTED", `Step ${at + 1} spends ${step.from.v.toUpperCase()} "of it", but step ${at} delivers ${asset.toUpperCase()}. Name the token step ${at + 1} spends.`, 422,
        [{ path: `actions[${at}].from`, message: "Not the previous step's output." }], REFUSAL_EXAMPLES);
    }
    if (asset && landing && !step.network) step.network = { v: landing, by: "derived", prov: { rule: "previous-output" } };
    return;
  }
  if (!asset || !landing || isUsdWord(asset)) return;
  step.from = { v: asset, by: "derived", prov: { rule: "previous-output" } };
  if (!step.network) step.network = { v: landing, by: "derived", prov: { rule: "previous-output" } };
}

/** Plural references to earlier outputs ("them", "both", "all of them"). */
const PLURAL_REFERENCE = /(?:^|\s)(?:them|those|these|both|all\s+of\s+them|each\s+of\s+them|both\s+of\s+them)(?:\s|$)/iu;

/**
 * "them" / "both" with more than one output still in the person's account (two
 * swaps, then "send them") cannot be read as one step's output. Kletia refuses
 * with the outputs listed instead of spending only the last one.
 */
export function pluralReference(clause: string, steps: readonly WorkStep[], at: number): PlatformError | null {
  const word = PLURAL_REFERENCE.exec(clause)?.[0].trim().toLowerCase();
  if (!word) return null;
  const open = steps.filter((step, index) => !paysSomeoneElse(step) && !(steps[index + 1] && spendsPrevious(steps[index + 1] as WorkStep)));
  if (open.length < 2 && !/(?:^|\s)both(?:\s|$)/iu.test(clause)) return null;
  const named = open.map((step) => outputOf(step)?.toUpperCase() ?? "its output").slice(0, 3);
  return new PlatformError(
    "INTENT_UNSUPPORTED",
    `Step ${at + 1} says "${word}", but ${open.length > 1 ? `${open.length} earlier steps each leave tokens (${named.join(", ")})` : "only one earlier step leaves tokens"}. ` +
      `Kletia does not guess which. Give each step its own amount and token, for example "swap 1 SOL to USDC, then bridge it to arbitrum".`,
    422,
    [{ path: `actions[${at}].amount`, message: "Several earlier outputs could be meant." }],
    REFUSAL_EXAMPLES,
  );
}

/**
 * "$SOL", "$usdc": a cashtag is the token when "$" is followed by a letter and
 * the rest is a listed symbol; "$50" stays fifty dollars.
 */
export function readCashtags(text: string): string {
  return text.replace(/(^|[\s(,])\$([A-Za-z][A-Za-z0-9.]{0,15})(?=$|[\s,;:!)])/gu, (match, before: string, symbol: string) => (knownSymbol(symbol) ? `${before}${symbol}` : match));
}

/** The closed-class rules a read step records in its slots and "Read as" items. */
export function stepRules(step: WorkStep): Set<string> {
  const rules = new Set<string>();
  for (const key of ["kind", "amount", "from", "to", "network", "toNetwork", "recipient", "protocol", "vault", "provider", "fundFrom"] as const) {
    const rule = (step[key] as { prov?: { rule?: string } } | undefined)?.prov?.rule;
    if (rule) rules.add(rule);
  }
  for (const item of step.readAs ?? []) rules.add(item.rule);
  return rules;
}

/** A keyword correction (verb, network, venue) or a digit read as a word: the clause is source C (one-click confirm). */
export const keywordCorrection = (correction: ThreadCorrection) => correction.material && !correction.field.endsWith(".amount") && correction.to !== "note";
