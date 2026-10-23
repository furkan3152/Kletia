/**
 * Frames (intent engine v2 §3.3): a clause's tokens become one Goal by role
 * assignment, driven by connectors and token order, not by a regex per
 * sentence shape. The rules (F1-F9):
 *
 * - F1 `AMOUNT? ASSET` nearest the verb (or leading the clause) is the object:
 *   what is spent, or for "buy / get / want" verbs what is wanted.
 * - F2 `to/for/into/as ASSET` is the asset wanted; "instead of ASSET" is spent.
 * - F3 `from NETWORK` is the source, `to/onto NETWORK` the destination; a lone
 *   `on/in NETWORK` fills whichever side is still open (both when neither).
 * - F4 `to ADDRESS/NAME/HOLDER` is the holder.
 * - F5 `into/in/at VENUE` is where the money should sit; "out of / from VENUE"
 *   and "my VENUE position" are where it sits now.
 * - F6 goal verbs set the kind; without a verb the kind comes from the shape.
 * - F7 ellipsis is handled by the clause splitter (clauses.ts).
 * - F8 "my USDC" with no amount spends all of it (scope "possessive").
 * - F9 "it", "the proceeds", "the USDC" (after a step) are the previous output.
 *
 * Fail closed: a NOISE word, two amounts for one side, a second verb that is
 * not an earn marker, or a role that cannot be filled leaves the clause
 * unread (null), never half-read.
 */
import type { AmountSel, AmountUnit, AssetSel, Custody, Goal, GoalKind, Holder, NetworkKey, Place, ProtocolId } from "@kletia/core";
import { getProtocol } from "@kletia/core";
import type { AmountCommentary } from "./amounts.js";
import type { Span, Token, VenueReading } from "./lexer.js";
import type { VerbEntry } from "./lexicon.js";
import { canonicalOn, lane, NETWORK_ORDER } from "../clarify/catalog.js";

/** The one mainnet network that lists a token ("SOL" -> solana), or undefined when it is listed on several. */
function uniqueHome(symbol: string): NetworkKey | undefined {
  const homes = NETWORK_ORDER.filter((network) => lane(network) === "mainnet" && canonicalOn(network, symbol) !== null);
  return homes.length === 1 ? homes[0] : undefined;
}

/** What lowering and the decision table need beyond the Goal (never serialised: it holds typed words). */
export interface GoalNotes {
  /** A side was filled by word order alone ("swap sol usdc 1"): D12 may confirm. */
  readonly orderOnly: boolean;
  /** F8: the amount came from "my X" with no number. */
  readonly possessive: boolean;
  /** The amount as typed ("1,000", "1k"), for corrections and the format check. */
  readonly amountRaw?: string;
  /** The amount form was rewritten ("1k" -> 1000): a material correction. */
  readonly rewritten?: { readonly from: string; readonly to: string };
  /** The verb's flags (buy / sell / whole). */
  readonly buy: boolean;
  readonly sell: boolean;
  /** The venue words as read (several readings for "jupiter"). */
  readonly wantVenue?: VenueReading;
  readonly fromVenue?: VenueReading;
  /** "on X" said once for the whole clause. */
  readonly place?: NetworkKey;
  /** An unknown symbol close to listed ones (D9 ASSET_TYPO). */
  readonly typo?: { readonly side: "spend" | "want"; readonly raw: string; readonly candidates: readonly string[] };
  /** The verb said, as the person typed it (lowering keeps strict-reader parity). */
  readonly verbWord?: string;
  /** The spend amount was a portion / max of the previous output (no asset said after a step). */
  readonly ofPrevious: boolean;
  /**
   * "buy 100 USDC of ETH": read as spending 100 USDC on ETH (the worth
   * reading), never the reversed one. Always confirmed (D12) before planning:
   * lowering keeps it a goal step so the solver asks.
   */
  readonly worthIdiom?: true;
  /** Spans the frame used, for the eval and corrections. */
  readonly spans: readonly Span[];
  /**
   * An amount was said only roughly ("around 3", "a couple of"): no amount is
   * read for that side, and the step is never chained to a previous output.
   */
  readonly vague?: true;
  /**
   * The amount was read from a form the person did not write as a plain number: a unit or multiplier ("1.5 k"
   * -> 1500), spaced thousands ("1 000"), European thousands ("1.000.000"), "and a half", "1/2 sol", arithmetic
   * ("10 + 5"): its "Read as" item and rule.
   */
  readonly amountForm?: { readonly raw: string; readonly unit?: AmountUnit; readonly rule: string; readonly readAs: string; readonly side: "spend" | "want" };
  /** Arithmetic the person wrote ("10 + 5"): a derived reading, always confirmed (source C, design A.3). */
  readonly derived?: "arithmetic";
  /** A side remark on the stated amount ("worth $150", "(half my stack)"), for the decision layer's cross-check. */
  readonly commentary?: AmountCommentary & { readonly side: "spend" | "want" };
  /** "stake the rest": the caller resolves what it is the rest of (design A.2 binding, red-team A7). */
  readonly rest?: true;
  /** "send 20 of it to carol.sns": an exact amount of the previous output's token; the caller binds the token (AQ2). */
  readonly ofPreviousExact?: true;
  /** Where the money is, as said ("from base", "my base usdc", "using eth on arbitrum"): the step's `fundFrom`. */
  readonly fundFrom?: NetworkKey;
  /** A network the clause did not say but the token implies (its only home network, AQ1): provenance "home-network". */
  readonly homeNetwork?: { readonly side: "spend" | "want"; readonly network: NetworkKey };
  /** Closed-class rules the frame applied ("amountVague:approx", "allBut:except", "connector:over", "unit:million"). */
  readonly rules: readonly string[];
}

export interface ReadGoal {
  readonly goal: Goal;
  readonly notes: GoalNotes;
}

export interface FrameContext {
  /** A step comes before this clause (in this message or the thread). */
  readonly previousExists: boolean;
  /** This goal's index in its list (chain.after points to index - 1). */
  readonly index: number;
  /**
   * False when the step before pays someone else: a clause that names no
   * amount and no token ("..., then swap to ETH") is then not chained to
   * that output (the policy asks for its amount). Default true.
   */
  readonly chainable?: boolean;
  /** AQ10: the clause said "<amount> <stablecoin> worth of <token>": the worth reading is what was said (source E). */
  readonly worthSaid?: boolean;
}

type Role = "spend" | "want";

interface Side {
  asset?: AssetSel;
  amount?: AmountSel;
  network?: NetworkKey;
  custody?: Custody;
  amountRaw?: string;
  rewritten?: { from: string; to: string };
  possessive?: boolean;
  /** How a spend-side network was said: "from base" / "my base usdc" (where the money is, fundFrom) or "on base". */
  networkBy?: "from" | "holding" | "place";
  /** "the rest" (A.2 binding). */
  rest?: boolean;
  /** "10 of it": an exact amount of the previous step's output token (AQ2). */
  ofPreviousExact?: boolean;
  /** A funding phrase named the spent token again ("put 50 usdc in kamino using my base usdc"). */
  funding?: boolean;
  /** The possessive was on a wallet holding ("my sol"), not on a venue position ("my aave position"). */
  holding?: boolean;
  previous?: boolean;
  venue?: VenueReading;
  /** An amount said only roughly: asked, never guessed. */
  vague?: boolean;
  form?: { raw: string; unit?: AmountUnit; rule: string; readAs: string };
  commentary?: AmountCommentary;
  derived?: "arithmetic";
}

/** Amount rules whose reading is shown as a "Read as" item (A.2, A.3): units, number forms, fractions, arithmetic. */
const FORM_RULE = /^(?:unit:|number:|format:|arithmetic:|fraction:(?:units|andAHalf)$)/u;

type AmountToken = Extract<Token, { t: "AMOUNT" }> | Extract<Token, { t: "VAGUE" }>;

const TO_CONNECTORS = new Set(["to", "into", "onto", "for", "as", "in exchange for"]);
const PLACE_CONNECTORS = new Set(["on", "in", "at"]);
const WITH_CONNECTORS = new Set(["with", "using", "via", "through", "by"]);
const DELIVER_KINDS: ReadonlySet<GoalKind> = new Set(["deliver"]);
/** Verbs after which "<amount> <stablecoin> of <token>" is a worth phrase ("buy 100 USDC of ETH"). */
const WORTH_VERBS: ReadonlySet<string> = new Set(["buy", "purchase", "get", "get me"]);
/** US dollar stablecoins for the worth phrase (listed symbols). */
const USD_STABLES: ReadonlySet<string> = new Set(["USDC", "USDT", "PYUSD", "DAI", "USDBC", "USDT0", "USDS"]);

const isUsdStable = (token: Token | undefined): boolean =>
  (token?.t === "ASSET" && USD_STABLES.has(token.symbol.toUpperCase())) || (token?.t === "CLASS" && token.cls === "usd-stable");

/**
 * "buy 100 USDC of ETH", "get 50 USDT of SOL" (design A.2 frames, red-team
 * A6): after buy / purchase / get, an amount of a dollar stablecoin followed
 * by "of" and another token means spending that many dollars on the token.
 * Word order alone would read it in reverse (want 100 USDC, pay in ETH).
 * Returns the token indexes of the stablecoin and of the wanted token.
 */
function worthPhrase(tokens: readonly Token[], verbIndex: number): { readonly stable: number; readonly wanted: number } | null {
  const verb = tokens[verbIndex];
  if (verb?.t !== "VERB" || !WORTH_VERBS.has(verb.raw.toLowerCase())) return null;
  const amount = tokens[verbIndex + 1];
  const of = tokens[verbIndex + 3];
  const wanted = tokens[verbIndex + 4];
  if (amount?.t !== "AMOUNT" || amount.sel.t !== "exact") return null;
  if (!isUsdStable(tokens[verbIndex + 2]) || of?.t !== "CONN" || of.word !== "of") return null;
  if (wanted?.t !== "ASSET" && wanted?.t !== "ASSET?") return null;
  if (isUsdStable(wanted)) return null;
  return { stable: verbIndex + 2, wanted: verbIndex + 4 };
}

/** The typed words a correction chip quotes: at most 16 characters (the thread's limit), cut with an ellipsis. */
function chipWords(raw: string): string {
  return raw.length <= 16 ? raw : `${raw.slice(0, 15).trimEnd()}…`;
}

function lendingCustody(venue: VenueReading, category: "lending" | "staking" | "any"): Custody {
  const protocol = venue.lending && getProtocol(venue.lending as ProtocolId) ? (venue.lending as ProtocolId) : undefined;
  return { kind: "venue", ...(protocol ? { protocol } : {}), category };
}

function stakingCustody(venue: VenueReading): Custody {
  const protocol = venue.provider && getProtocol(venue.provider as ProtocolId) ? (venue.provider as ProtocolId) : undefined;
  return { kind: "venue", ...(protocol ? { protocol } : {}), category: "staking" };
}

function positionCustody(venue: VenueReading): Custody {
  const protocol = venue.lending && getProtocol(venue.lending as ProtocolId) ? (venue.lending as ProtocolId) : undefined;
  return { kind: "position", ...(protocol ? { protocol } : {}) };
}

/**
 * The Goal one clause's tokens describe, or null when the clause cannot be
 * read consistently (fail closed).
 */
/** Words that introduce the networks of a split ("50/50 between base and arbitrum"): only inside a weight list. */
const SPLIT_ACROSS: ReadonlySet<string> = new Set(["between", "across"]);

/**
 * Rebalance weights (design A.2 amounts, A.6, red-team A15), only after a
 * rebalance verb and only in two shapes:
 * - asset axis: "rebalance to 50/50 eth usdc on arbitrum" (one token or
 *   class per weight, in order; the network is the scope);
 * - network axis: "rebalance my usdc 50/50 between base and arbitrum" (one
 *   network per weight, in order; the token is the one said before).
 * Anything else with a weight list ("swap 60/40 sol usdc") is not read. The
 * weights are what the person wrote; every move is computed and confirmed.
 */
function rebalanceFrame(tokens: readonly Token[]): ReadGoal | null {
  const verb = tokens[0];
  if (verb?.t !== "VERB" || verb.verb.kind !== "rebalance") return null;
  const lists = tokens.filter((token) => token.t === "WEIGHTS");
  if (lists.length !== 1) return null;
  const weightsAt = tokens.findIndex((token) => token.t === "WEIGHTS");
  const weights = (tokens[weightsAt] as Extract<Token, { t: "WEIGHTS" }>).weights;
  let at = 1;
  let asset: AssetSel | undefined;
  if (tokens[at]?.t === "POSS") at += 1;
  const before = tokens[at];
  if (at < weightsAt && (before?.t === "ASSET" || before?.t === "CLASS")) {
    asset = before.t === "ASSET" ? { symbol: before.symbol } : { class: before.cls };
    at += 1;
  }
  const into = tokens[at];
  if (at < weightsAt && into?.t === "CONN" && (into.word === "to" || into.word === "into")) at += 1;
  if (at !== weightsAt) return null;
  at = weightsAt + 1;
  const networkOfToken = (token: Token | undefined): NetworkKey | undefined => (token?.t === "NETWORK" && !token.generic ? token.network : token?.t === "ASSET" ? token.network : undefined);
  const keys: string[] = [];
  let axis: "asset" | "network";
  let scope: NetworkKey | undefined;
  const lead = tokens[at];
  if (lead?.t === "NOISE" && SPLIT_ACROSS.has(lead.raw.toLowerCase())) {
    // Network axis: "between base and arbitrum".
    if (!asset) return null;
    axis = "network";
    at += 1;
    while (at < tokens.length) {
      const token = tokens[at];
      if (token?.t === "CONN" && token.word === "and" && keys.length > 0) {
        at += 1;
        continue;
      }
      const network = networkOfToken(token);
      if (!network) return null;
      keys.push(network);
      at += 1;
    }
  } else {
    // Asset axis: "50/50 eth usdc [on arbitrum]".
    if (asset) return null;
    axis = "asset";
    while (at < tokens.length && keys.length < weights.length) {
      const token = tokens[at];
      if (token?.t === "CONN" && token.word === "and" && keys.length > 0) {
        at += 1;
        continue;
      }
      if (token?.t === "ASSET") keys.push(token.symbol);
      else if (token?.t === "CLASS" && token.cls !== "gas") keys.push(token.cls);
      else return null;
      at += 1;
    }
    const conn = tokens[at];
    if (conn?.t === "CONN" && (conn.word === "on" || conn.word === "in")) {
      scope = networkOfToken(tokens[at + 1]);
      if (!scope) return null;
      at += 2;
    }
    if (at !== tokens.length) return null;
  }
  if (keys.length !== weights.length || new Set(keys.map((key) => key.toUpperCase())).size !== keys.length) return null;
  const goal: Goal = {
    kind: "rebalance",
    spend: { ...(asset ? { asset } : {}) },
    want: {},
    holder: { t: "self" },
    constraints: {},
    targets: { axis, ...(scope ? { scope: { network: scope, custody: { kind: "wallet" } } } : {}), weights: keys.map((key, index) => ({ key, bps: (weights[index] as number) * 100 })) },
    confidence: "frame",
  };
  return { goal, notes: { orderOnly: false, possessive: false, buy: false, sell: false, verbWord: verb.raw.toLowerCase(), ofPrevious: false, spans: tokens.map((token) => token.span), rules: [] } };
}

export function readFrame(input: readonly Token[], ctx: FrameContext): ReadGoal | null {
  if (input.length === 0) return null;
  // "rebalance to 50/50 eth usdc on arbitrum": a weight list has its own two shapes, never the general frames.
  if (input.some((token) => token.t === "WEIGHTS")) return rebalanceFrame(input);
  const tokens = nicknames(input);
  if (tokens.some((token) => token.t === "NOISE")) return null;

  // F6: the first verb sets the kind; a later verb may only be an earn marker ("make my SOL earn").
  const verbIndex = tokens.findIndex((token) => token.t === "VERB");
  const verbToken = verbIndex >= 0 ? (tokens[verbIndex] as Extract<Token, { t: "VERB" }>) : undefined;
  let verb: VerbEntry | undefined = verbToken?.verb;
  let work = tokens.some((token) => token.t === "WORK");
  for (const [index, token] of tokens.entries()) {
    if (token.t !== "VERB" || index === verbIndex) continue;
    if (token.verb.kind === "earn" && !token.verb.op) work = true;
    else return null;
  }
  if (verb?.needsWork && !work) return null;
  // A verb that is not first is fine only after a leading venue or amount ("aave 100 usdc base" has none).
  if (verbIndex > 0 && tokens.slice(0, verbIndex).some((token) => token.t !== "DET" && token.t !== "POSS")) return null;
  if (!verb && work) verb = { kind: "earn", object: "spend" };
  // AQ8: an earn marker turns an acquire into earn ("get me some yield on solana with 50 usdc").
  if (verb?.kind === "acquire" && !verb.buy && work) verb = { kind: "earn", object: "spend" };

  const spend: Side = {};
  const want: Side = {};
  let holder: Holder = { t: "self" };
  let holderSaid = false;
  let place: NetworkKey | undefined;
  /** RF3 (design A.2 frames, red-team A6): a second "on/in NETWORK" attaches by adjacency to the asset it follows. */
  let secondPlace: { network: NetworkKey; role: Role } | undefined;
  let placeRole: Role | undefined;
  let placeVenue: Role | undefined;
  let lastAsset: { index: number; role: Role } | undefined;
  let current = -1;
  /** AQ1: a wanted token named by an asset-network word after a convert verb ("to sol") is wanted on its home network. */
  let wantHome: NetworkKey | undefined;
  let orderOnly = false;
  let typo: GoalNotes["typo"];
  const via: ProtocolId[] = [];
  let prefer: "cheapest" | "fastest" | "safest" | undefined;
  let conn: string | undefined;
  let pending: AmountToken | undefined;
  const rules = new Set<string>();
  let possessive = false;
  let determiner = false;
  const object: Role = verb?.object ?? "spend";
  const other: Role = object === "spend" ? "want" : "spend";
  const side = (role: Role) => (role === "spend" ? spend : want);
  const spans: Span[] = [];
  const worth = verbIndex >= 0 ? worthPhrase(tokens, verbIndex) : null;
  // The worth reading is still confirmed before planning: it is not what the words say in order.
  if (worth && !ctx.worthSaid) orderOnly = true;

  const bindAmount = (role: Role, token: AmountToken): boolean => {
    const target = side(role);
    if (target.amount || target.vague) return false;
    spans.push(token.span);
    if (token.rule) rules.add(token.rule);
    if (token.t === "VAGUE") {
      for (const rule of token.rules ?? []) rules.add(rule);
      target.vague = true;
      return true;
    }
    target.amount = token.sel;
    if (token.sel.t === "exact") target.amountRaw = token.raw;
    if (token.rule && FORM_RULE.test(token.rule)) target.form = { raw: token.raw, ...(token.unit ? { unit: token.unit } : {}), rule: token.rule, readAs: token.readAs ?? renderSel(token.sel) };
    else if (token.rewritten && token.sel.t === "exact") target.rewritten = { from: chipWords(token.raw), to: token.readAs ?? token.sel.value };
    if (token.commentary) target.commentary = token.commentary;
    if (token.derived) target.derived = token.derived;
    return true;
  };

  /** The role an asset (or class) takes after the current connector (`index`: its token). */
  const assetRole = (index: number): Role | null => {
    if (worth && index === worth.stable) return "spend";
    if (worth && index === worth.wanted) return "want";
    if (conn === undefined || conn === "of") {
      if (!side(object).asset && !side(object).previous) return object;
      if (!side(other).asset) {
        orderOnly = true;
        return other;
      }
      return null;
    }
    if (TO_CONNECTORS.has(conn)) return "want";
    if (conn === "instead of") return "spend";
    if (WITH_CONNECTORS.has(conn)) return "spend";
    return null;
  };

  const placeAssetLike = (role: Role, asset: AssetSel, span: Span): boolean => {
    const target = side(role);
    if (target.asset) return false;
    target.asset = asset;
    lastAsset = { index: current, role };
    spans.push(span);
    if (pending && (conn === undefined || conn === "of" || WITH_CONNECTORS.has(conn ?? "") || TO_CONNECTORS.has(conn ?? ""))) {
      if (!bindAmount(role, pending)) return false;
      pending = undefined;
    }
    if (determiner && ctx.previousExists && role === "spend" && !target.amount && !target.vague) {
      target.amount = { t: "previous" };
      target.previous = true;
    }
    if (possessive && role === "spend" && !target.amount && !target.vague) {
      target.amount = { t: "max" };
      target.possessive = true;
      target.holding = true;
    }
    possessive = false;
    determiner = false;
    return true;
  };

  /** Network-or-asset words ("sol", "arb", "op", "matic") read by their neighbours. */
  const networkReading = (index: number, token: Extract<Token, { t: "ASSET" }>): boolean => {
    if (!token.network) return false;
    if (pending) return false;
    if (conn === "from" || conn === "on" || conn === "in" || conn === "at") return true;
    const before = tokens[index - 1];
    const beforeConn = tokens[index - 2];
    if (conn !== undefined && TO_CONNECTORS.has(conn)) {
      // AQ1, F-1 (design A.2 frames): after a convert verb with no wanted token yet, "to sol" / "into eth" names the
      // token wanted ("turn my base eth into sol on solana"), never the network.
      if (verb && verb.kind === "convert" && !want.asset) return false;
      // "X to sol": a network when the other end of "to" is a network or the verb moves money.
      if (beforeConn?.t === "NETWORK" || (beforeConn?.t === "ASSET" && beforeConn.network && tokens[index - 3]?.t === "NETWORK")) return true;
      if (spend.network && !spend.asset) return true;
      if (verb && (verb.kind === "relocate" || verb.op === "bridge")) return true;
      if (spend.network) return true;
      return false;
    }
    if (conn === undefined && before && (before.t === "ASSET" || before.t === "NAME" || before.t === "ADDRESS" || before.t === "AMOUNT" || before.t === "VENUE")) {
      // A bare network word after the object ("5 usdc -> vitalik.eth op", "aave 100 usdc base").
      return before.t !== "AMOUNT" && (spend.asset !== undefined || want.asset !== undefined || holderSaid);
    }
    return false;
  };

  /**
   * "fund my arbitrum wallet", "send 5 USDC to my base account": the person's
   * own account on that network is where the money should arrive.
   */
  const placeOwnWallet = (network: NetworkKey, span: Span): boolean => {
    if (holderSaid || (want.network && want.network !== network)) return false;
    if (conn !== undefined && conn !== "to" && conn !== "onto" && conn !== "into" && conn !== "for") return false;
    if (verb && verb.kind !== "deliver" && verb.kind !== "relocate" && verb.kind !== "acquire") return false;
    if (verb?.buy || pending) return false;
    want.network = network;
    holder = { t: "self" };
    holderSaid = true;
    possessive = false;
    spans.push(span);
    return true;
  };

  const placeNetwork = (index: number, network: NetworkKey, span: Span): boolean => {
    spans.push(span);
    const next = tokens[index + 1];
    if (conn === "from") {
      if (spend.network) return false;
      spend.network = network;
      spend.networkBy = "from";
    } else if (conn !== undefined && WITH_CONNECTORS.has(conn) && next?.t === "ASSET") {
      // AQ11, RF4: "using my base usdc", "pay with base usdc": where the money is (fundFrom).
      if (spend.network && spend.network !== network) return false;
      spend.network = network;
      spend.networkBy = "holding";
    } else if (conn !== undefined && (conn === "to" || conn === "onto" || conn === "into")) {
      if (want.network) return false;
      want.network = network;
    } else if (conn !== undefined && PLACE_CONNECTORS.has(conn)) {
      // The asset right before "on" ("0.1 eth on base"): the network is where that asset is (spend) or should be (want).
      const adjacent = lastAsset && lastAsset.index === index - 2 && tokens[index - 1]?.t === "CONN" ? lastAsset.role : undefined;
      if (place && place !== network) {
        if (secondPlace || !adjacent || !placeRole || adjacent === placeRole) return false;
        secondPlace = { network, role: adjacent };
        return true;
      }
      if (!place) {
        placeRole = adjacent;
        // RF4: "move my kamino position to aave on base": a network right after a venue is that venue's.
        const venueBefore = tokens[index - 2]?.t === "VENUE" && tokens[index - 1]?.t === "CONN";
        if (venueBefore && want.venue && tokens[index - 2] && (tokens[index - 2] as Extract<Token, { t: "VENUE" }>).venue === want.venue) placeVenue = "want";
      }
      place = network;
    } else if (conn === undefined) {
      if (possessive || (next?.t === "CONN" && (next.word === "to" || next.word === "onto"))) {
        if (spend.network) return false;
        spend.network = network;
        spend.networkBy = possessive ? "holding" : "from";
      } else {
        if (place && place !== network) return false;
        place = network;
      }
    } else {
      return false;
    }
    return true;
  };

  for (const [index, token] of tokens.entries()) {
    current = index;
    if (index === verbIndex) {
      conn = undefined;
      continue;
    }
    switch (token.t) {
      case "CONN":
        if (token.word === "and" || token.word === "then") return null;
        if (token.rule) rules.add(token.rule);
        if (token.word === "of") {
          if (conn === undefined || pending) {
            if (!conn) conn = "of";
            continue;
          }
          continue;
        }
        if (pending && TO_CONNECTORS.has(token.word) && !side(object).asset) {
          // "send $5 to vitalik.eth": an amount with no asset belongs to the object.
          if (!bindAmount(object, pending)) return null;
          pending = undefined;
        }
        conn = token.word;
        continue;
      case "DET":
        determiner = true;
        continue;
      case "POSS":
        possessive = true;
        continue;
      case "PREFER":
        prefer = token.prefer;
        conn = undefined;
        continue;
      case "WORK":
        conn = undefined;
        continue;
      case "POSITION": {
        // "my aave position": the venue just read is where the money sits now.
        if (want.venue && !spend.venue && want.custody?.kind === "venue") {
          spend.venue = want.venue;
          spend.custody = positionCustody(want.venue);
          delete want.venue;
          delete want.custody;
        } else if (!spend.venue) return null;
        conn = undefined;
        continue;
      }
      case "VAGUE":
      case "AMOUNT": {
        if (pending) return null;
        if (conn !== undefined && conn !== "of" && !WITH_CONNECTORS.has(conn) && !TO_CONNECTORS.has(conn)) return null;
        if (conn !== undefined && TO_CONNECTORS.has(conn)) {
          // "... to 100 USDC": a target amount of what is wanted.
          if (!bindAmount("want", token)) return null;
          continue;
        }
        pending = token;
        if (WITH_CONNECTORS.has(conn ?? "")) conn = "with";
        continue;
      }
      case "REF": {
        if (!ctx.previousExists) return null;
        const role: Role = conn !== undefined && TO_CONNECTORS.has(conn) ? "want" : "spend";
        if (pending && pending.t === "AMOUNT" && pending.sel.t === "exact" && conn === "of" && role === "spend" && !spend.amount && !spend.asset && /^(?:it|them|that|those|the proceeds|the output)$/u.test(token.raw.toLowerCase())) {
          // AQ2 (design A.2 binding): "10 of it", "60 of them" is exactly that many of the previous step's output token.
          if (!bindAmount("spend", pending)) return null;
          pending = undefined;
          spend.ofPreviousExact = true;
          spans.push(token.span);
          conn = undefined;
          continue;
        }
        if (role === "spend" && conn === "of" && !pending && spend.asset && spend.amount?.t === "exact" && !spend.ofPreviousExact && /^(?:it|them|that|those|the proceeds|the output)$/u.test(token.raw.toLowerCase())) {
          // "send 10 usdc of it": the token is said too; the caller checks it is the previous output's (AQ2).
          spend.ofPreviousExact = true;
          spans.push(token.span);
          conn = undefined;
          continue;
        }
        if (role !== "spend" || spend.amount) return null;
        spend.amount = { t: "previous" };
        spend.previous = true;
        // "the rest": the caller decides what it is the rest of (design A.2 binding); never just the previous output.
        if (/^the rest$/u.test(token.raw.toLowerCase())) spend.rest = true;
        spans.push(token.span);
        conn = undefined;
        continue;
      }
      case "WALLET":
        // Read with the network word before it (placeOwnWallet).
        if (tokens[index - 1]?.t !== "NETWORK" && tokens[index - 1]?.t !== "ASSET") return null;
        conn = undefined;
        continue;
      case "ASSET": {
        if (token.network && tokens[index + 1]?.t === "WALLET") {
          if (!placeOwnWallet(token.network, token.span)) return null;
          conn = undefined;
          continue;
        }
        if (networkReading(index, token)) {
          if (!placeNetwork(index, token.network as NetworkKey, token.span)) return null;
          conn = undefined;
          continue;
        }
        if (PLACE_CONNECTORS.has(conn ?? "") || conn === "from") {
          // "in SOL" / "from USDC" with no network reading: not a role the frames know.
          return null;
        }
        if (spend.asset && conn !== undefined && WITH_CONNECTORS.has(conn) && !pending && sameSel(spend.asset, { symbol: token.symbol })) {
          // "put 50 usdc in kamino using my base usdc": the funding phrase names the spent token again; it says where
          // the money is, not a second amount.
          spend.funding = true;
          possessive = false;
          determiner = false;
          spans.push(token.span);
          lastAsset = { index, role: "spend" };
          conn = undefined;
          continue;
        }
        const role = assetRole(index);
        if (!role) return null;
        // "swap 1 sol 2 usdc": a second amount whose side only word order gives is never read (the "2" may be "to";
        // U2 NOI009). Both amounts with a connector ("swap 1 sol for 2 usdc") stay a target.
        if (pending && role === other && (conn === undefined || conn === "of") && side(object).amount) return null;
        const toWord = conn !== undefined && TO_CONNECTORS.has(conn);
        if (!placeAssetLike(role, { symbol: token.symbol }, token.span)) return null;
        if (token.venue && role === "want" && token.venue.provider) side(role).venue = token.venue;
        const wantVerb = verb !== undefined && (verb.kind === "convert" || verb.kind === "acquire") && (toWord || (verb.object === "want" && conn === undefined));
        if (role === "want" && wantVerb && uniqueHome(token.symbol) && (!token.network || uniqueHome(token.symbol) === token.network)) wantHome = uniqueHome(token.symbol);
        conn = undefined;
        continue;
      }
      case "ASSET?": {
        const role = assetRole(index);
        if (!role || typo) return null;
        if (!placeAssetLike(role, { symbol: token.raw }, token.span)) return null;
        typo = { side: role, raw: token.raw.slice(0, 16), candidates: token.candidates };
        conn = undefined;
        continue;
      }
      case "CLASS": {
        const role = token.cls === "gas" ? "want" : assetRole(index);
        if (!role) return null;
        if (!placeAssetLike(role, { class: token.cls }, token.span)) return null;
        conn = undefined;
        continue;
      }
      case "NETWORK":
        if (tokens[index + 1]?.t === "WALLET") {
          if (!placeOwnWallet(token.network, token.span)) return null;
          conn = undefined;
          continue;
        }
        {
          // "half of my arbitrum usdc", "25% of my base usdc": the network belongs to the holding; the amount binds at its asset.
          const holding = possessive && tokens[index + 1]?.t === "ASSET";
          if (pending && !holding) {
            // "25 base"? An amount must be followed by its asset or a connector.
            if (!bindAmount(object, pending)) return null;
            pending = undefined;
          }
          if (holding && conn === "of") conn = undefined;
        }
        {
          const fundingPrefix = conn !== undefined && WITH_CONNECTORS.has(conn) && tokens[index + 1]?.t === "ASSET";
          if (!placeNetwork(index, token.network, token.span)) return null;
          possessive = possessive && tokens[index + 1]?.t === "ASSET";
          if (!fundingPrefix) conn = undefined;
        }
        continue;
      case "VENUE": {
        spans.push(token.span);
        const venue = token.venue;
        const exitVerb = verb?.kind === "exit";
        const positionNext = tokens[index + 1]?.t === "POSITION" || (tokens[index + 1]?.t === "ASSET" && tokens[index + 2]?.t === "POSITION");
        // WP1 (design A.2 frames): a venue's category comes from the registry. A DEX or bridge after on/in/at/via
        // is a route constraint, never custody; a venue with both a route and a custody category (jupiter) takes
        // its category from the verb, and with no verb the clause is not read (VENUE_AMBIGUOUS).
        const routes = venue.dex !== undefined || venue.bridge !== undefined;
        const custodies = venue.lending !== undefined || venue.provider !== undefined || venue.best === true;
        const bridging = verb !== undefined && (verb.kind === "relocate" || verb.op === "bridge");
        const routeVerb = verb !== undefined && (bridging || verb.kind === "convert" || verb.op === "swap" || (verb.kind === "acquire" && !work));
        if (routes && conn !== undefined && (PLACE_CONNECTORS.has(conn) || WITH_CONNECTORS.has(conn)) && !positionNext) {
          if (custodies && !verb) return null;
          if (!custodies || routeVerb) {
            const pick = verb === undefined ? venue.dex ?? venue.bridge : bridging ? venue.bridge : venue.dex;
            if (pick && getProtocol(pick as ProtocolId)) {
              via.push(pick as ProtocolId);
              conn = undefined;
              continue;
            }
            // "bridge 10 usdc to base on uniswap": a route venue of the other kind for this verb is not read.
            if (!custodies) return null;
          }
        }
        if (conn === "out of" || conn === "from" || ((conn === undefined || conn === "in" || conn === "on") && (exitVerb || possessive) && !venue.best) || positionNext) {
          if (spend.venue || venue.best) return null;
          spend.venue = venue;
          spend.custody = positionCustody(venue);
          // "my aave USDC": the possessive carries over to the asset after the venue; "my aave position" is all of it.
          if (tokens[index + 1]?.t !== "ASSET") {
            if (possessive && !spend.amount) {
              if (pending?.t === "AMOUNT" && pending.sel.t === "portion") {
                // "redeem half my aave position": a share of the position.
                if (!bindAmount("spend", pending)) return null;
                pending = undefined;
              } else {
                spend.amount = { t: "max" };
                spend.possessive = true;
              }
            }
            possessive = false;
          }
        } else if (conn === undefined || conn === "into" || conn === "in" || conn === "to" || conn === "at" || conn === "on" || conn === "onto") {
          if (want.venue) return null;
          want.venue = venue;
          want.custody = venue.best ? { kind: "venue", category: "any" } : venue.provider && !venue.lending ? stakingCustody(venue) : lendingCustody(venue, venue.lending ? "lending" : "any");
        } else if (WITH_CONNECTORS.has(conn ?? "")) {
          if (venue.provider && (verb?.op === "stake" || verb?.kind === "earn" || !verb)) {
            if (want.venue) return null;
            want.venue = venue;
            want.custody = stakingCustody(venue);
          } else if (venue.dex || venue.bridge) {
            const protocol = (venue.dex ?? venue.bridge) as ProtocolId;
            if (getProtocol(protocol)) via.push(protocol);
          } else if (venue.lending) {
            if (want.venue) return null;
            want.venue = venue;
            want.custody = lendingCustody(venue, "lending");
          } else return null;
        } else {
          return null;
        }
        conn = undefined;
        continue;
      }
      case "ADDRESS":
      case "NAME":
      case "HOLDER": {
        const deliverish = !verb || verb.kind === "deliver" || verb.kind === "relocate";
        const right = conn === "to" || conn === "for" || (conn === undefined && verbToken && index === verbIndex + 1 && verb?.kind === "deliver");
        if (!right || !deliverish || holderSaid) return null;
        holder = token.t === "ADDRESS" ? { t: "address", value: token.value } : token.t === "NAME" ? { t: "name", value: token.value } : token.holder === "self" ? { t: "self" } : { t: token.holder };
        holderSaid = true;
        spans.push(token.span);
        if (pending) {
          if (!bindAmount(object, pending)) return null;
          pending = undefined;
        }
        conn = undefined;
        continue;
      }
      default:
        return null;
    }
  }
  if (possessive && !spend.asset && !spend.venue) return null;
  if (pending) {
    // A trailing amount ("sol to usdc 1", "usdc base>arb 25") belongs to the object.
    if (!bindAmount(object, pending)) return null;
    pending = undefined;
  }
  // A dangling "to" ("swap 1 SOL to") leaves the wanted asset open: the policy asks for it.
  const lastToken = tokens[tokens.length - 1];
  if (conn !== undefined && conn !== "of" && !(TO_CONNECTORS.has(conn) && lastToken?.t === "CONN" && !want.asset && !want.network)) return null;

  // F3: a lone "on/in NETWORK" fills whichever side is still open; for "get / want" verbs
  // it is where the money is wanted (the source stays open), for an exit where the position is.
  const lanes = [place, secondPlace?.network, spend.network, want.network].filter((network): network is NetworkKey => network !== undefined);
  let home_: GoalNotes["homeNetwork"];
  // Only when the clause says where the money is and it is elsewhere: "swap 1 usdc to sol" alone stays as it was read.
  const spentOn = spend.network ?? place;
  if (wantHome && !want.network && spentOn && spentOn !== wantHome && lanes.every((network) => lane(network) === "mainnet")) {
    want.network = wantHome;
    home_ = { side: "want", network: wantHome };
  }
  const spendSaid = spend.network;
  if (place && secondPlace && placeRole) {
    // "swap 0.1 eth on base for sol on solana": each network belongs to the asset it follows (RF3).
    for (const [role, network] of [[placeRole, place], [secondPlace.role, secondPlace.network]] as const) {
      const target = side(role);
      if (target.network && target.network !== network) return null;
      target.network = network;
    }
    rules.add("network:adjacent");
  } else if (place && placeVenue === "want" && spend.custody?.kind === "position" && !want.network) {
    // The position being left stays where it is; only the new venue is on the said network.
    want.network = place;
  } else if (place && placeRole === "spend" && spend.funding && (!spend.network || spend.network === place)) {
    // "stake 0.1 eth with rocket pool using eth on arbitrum": the network of the funding phrase is where the money is.
    spend.network = place;
    spend.networkBy = "holding";
  } else if (place && object === "want" && !want.network && !spend.asset) {
    want.network = place;
  } else if (place && verb?.kind === "exit" && !spend.network) {
    spend.network = place;
  } else if (place) {
    if (spend.network && !want.network) want.network = place;
    else if (want.network && !spend.network) spend.network = place;
    else if (!spend.network && !want.network) {
      spend.network = place;
      want.network = place;
    } else if (spend.network !== place && want.network !== place) return null;
  }
  // AQ1 (design A.2 frames, lower.ts home network): a spent token that is not listed where the clause wants the
  // result, and lives on one network only ("turn 1 sol into eth on base"), is spent where it lives.
  const spendSymbol = spend.asset && "symbol" in spend.asset ? spend.asset.symbol : undefined;
  if (spendSymbol && !spendSaid && want.network && placeRole !== "spend" && lane(want.network) === "mainnet" && canonicalOn(want.network, spendSymbol) === null) {
    const home = uniqueHome(spendSymbol);
    if (home && home !== want.network) {
      spend.network = home;
      home_ = { side: "spend", network: home };
    }
  }

  // F9 without a word: "..., bridge to base" / "and earn yield" after a step continues with its output.
  const implicit = ctx.previousExists && ctx.chainable !== false && object === "spend" && !spend.asset && !spend.amount && !spend.vague && !spend.venue && verb !== undefined;
  if (implicit) {
    spend.amount = { t: "previous" };
    spend.previous = true;
  }
  // "move everything to base": all of every asset, a sweep only the solver can plan.
  const sweep = !spend.asset && !spend.venue && spend.amount?.t === "max" && !ctx.previousExists && (verb?.kind === "relocate" || verb?.kind === "deliver");
  const kind = sweep ? "consolidate" : goalKind(verb, spend, want, holderSaid, holder, { work, ...(verbToken ? { verbWord: verbToken.raw.toLowerCase() } : {}) });
  if (!kind) return null;
  // C11 (design A.2 binding): "my X" with no amount is all of it only when the value stays the same asset in the
  // person's custody (stake, deposit, withdraw on X's own network). A conversion, crossing, payment or exposure
  // goal with "my X" asks how much instead.
  if (spend.holding && spend.amount?.t === "max" && !custodyMove(kind, spend, want, holder)) {
    delete spend.amount;
    spend.possessive = false;
    spend.holding = false;
  }
  if (verb?.whole && !spend.amount && !spend.vague) spend.amount = { t: "max" };
  // "swap 1 sol for 2 usdc": an amount on both sides of a conversion cannot both hold (the second is a price the
  // route cannot promise); never planned on one of them alone.
  if ((kind === "convert" || kind === "acquire") && spend.amount && want.amount && spend.amount.t !== "previous") return null;
  if (!spend.asset && !want.asset && !spend.venue && !want.venue && !holderSaid && !spend.previous && kind !== "consolidate") return null;

  const from: Place | undefined = spend.network || spend.custody ? { ...(spend.network ? { network: spend.network } : {}), custody: spend.custody ?? { kind: "wallet" } } : undefined;
  const at: Place | undefined = want.network || want.custody ? { ...(want.network ? { network: want.network } : {}), custody: want.custody ?? { kind: "wallet" } } : undefined;
  const goal: Goal = {
    kind,
    // "put X into USDC" read as a conversion keeps no deposit op.
    ...(verb?.op && !(kind === "convert" && verb.op !== "swap") ? { op: verb.op } : kind === "deliver" && holderSaid && holder.t !== "self" ? { op: "transfer" as const } : {}),
    spend: { ...(spend.asset ? { asset: spend.asset } : {}), ...(spend.amount ? { amount: spend.amount } : {}), ...(from ? { from } : {}) },
    want: { ...(want.asset ? { asset: want.asset } : {}), ...(want.amount ? { amount: want.amount } : {}), ...(at ? { at } : {}) },
    holder,
    constraints: { ...(via.length > 0 ? { via: [...new Set(via)] } : {}), ...(prefer ? { prefer } : {}) },
    ...(spend.previous && ctx.index > 0 ? { chain: { after: ctx.index - 1 } } : {}),
    confidence: "frame",
  };
  const ofPrevious = ctx.previousExists && !spend.asset && !spend.possessive && (spend.amount?.t === "portion" || spend.amount?.t === "max") && !spend.venue;
  return {
    goal,
    notes: {
      orderOnly,
      possessive: spend.possessive === true,
      ...(spend.amountRaw ? { amountRaw: spend.amountRaw } : {}),
      ...(spend.rewritten ?? want.rewritten ? { rewritten: (spend.rewritten ?? want.rewritten) as { from: string; to: string } } : {}),
      buy: verb?.buy === true,
      sell: verb?.sell === true,
      ...(want.venue ? { wantVenue: want.venue } : {}),
      ...(spend.venue ? { fromVenue: spend.venue } : {}),
      ...(place ? { place } : {}),
      ...(typo ? { typo } : {}),
      ...(verbToken ? { verbWord: verbToken.raw.toLowerCase() } : {}),
      ofPrevious,
      ...(worth && !ctx.worthSaid ? { worthIdiom: true as const } : {}),
      spans,
      ...(spend.vague || want.vague ? { vague: true as const } : {}),
      ...(spend.form ? { amountForm: { ...spend.form, side: "spend" as const } } : want.form ? { amountForm: { ...want.form, side: "want" as const } } : {}),
      ...(spend.derived ?? want.derived ? { derived: "arithmetic" as const } : {}),
      ...(spend.commentary ? { commentary: { ...spend.commentary, side: "spend" as const } } : want.commentary ? { commentary: { ...want.commentary, side: "want" as const } } : {}),
      ...(home_ ? { homeNetwork: home_ } : {}),
      ...(spend.ofPreviousExact ? { ofPreviousExact: true as const } : {}),
      ...(spend.rest ? { rest: true as const } : {}),
      ...(spend.network && (spend.networkBy === "from" || spend.networkBy === "holding") ? { fundFrom: spend.network } : {}),
      rules: [...rules],
    },
  };
}

/** A short rendering of an amount for a "Read as" item when the lexer gave none. */
function renderSel(sel: AmountSel): string {
  switch (sel.t) {
    case "exact":
      return sel.value;
    case "usd":
      return `$${sel.value}`;
    case "portion":
      return `${sel.bps / 100}%`;
    default:
      return sel.t;
  }
}

/** F6: the kind from the verb, adjusted by what the clause names; or from the clause's shape when no verb was said. */
/** Earn verbs that also say "turn into" ("put 30% of my SOL into USDC", "invest 100 USDC into SOL"). */
const INTO_VERBS: ReadonlySet<string> = new Set(["put", "place", "invest"]);

function goalKind(verb: VerbEntry | undefined, spend: Side, want: Side, holderSaid: boolean, holder: Holder, said: { readonly work: boolean; readonly verbWord?: string }): GoalKind | null {
  const moves = spend.network !== undefined && want.network !== undefined && spend.network !== want.network;
  const sameAsset = !want.asset || !spend.asset || sameSel(spend.asset, want.asset);
  // Money that sits in a venue position now leaves it first ("move my aave USDC to morpho").
  if (spend.custody?.kind === "position" && (!verb || verb.kind !== "deliver")) return "exit";
  if (verb) {
    switch (verb.kind) {
      case "deliver":
        if (holderSaid && holder.t !== "self") return "deliver";
        // "send 25 USDC to solana" / "send 5 USDC to myself on solana": money moves between the person's own wallets.
        if (want.network && (moves || !spend.network || holderSaid)) return "relocate";
        return holderSaid ? "relocate" : "deliver";
      case "relocate":
        if (holderSaid && holder.t !== "self") return "deliver";
        if (want.custody?.kind === "venue") return "earn";
        return "relocate";
      case "acquire":
        if (want.custody?.kind === "venue") return "earn";
        // "fund my polygon wallet with 5 USDC": bring that asset to the person's own account there.
        if (holderSaid && holder.t === "self" && want.network && spend.asset && !want.asset && !verb.buy) return "relocate";
        if (spend.asset && want.asset && !sameSel(spend.asset, want.asset)) return "convert";
        if (verb.buy) return "convert";
        if (moves && sameAsset) return "relocate";
        return "acquire";
      case "convert":
        if (want.custody?.kind === "venue") return "earn";
        return "convert";
      case "earn":
        // A token that is not a venue or a staking token as the destination: "put 30% of my SOL into
        // USDC" converts; any other earn verb with one is not read (an earn never drops the wanted token).
        if (want.asset && !want.venue && !want.custody) {
          const into = !said.work && said.verbWord !== undefined && INTO_VERBS.has(said.verbWord);
          return into && spend.asset && !sameSel(spend.asset, want.asset) ? "convert" : null;
        }
        return "earn";
      case "exit":
        // "withdraw 50 USDC": the verb alone says exit; the venue is asked.
        return spend.venue || verb.op === "withdraw" ? "exit" : null;
      default:
        return verb.kind;
    }
  }
  if (holderSaid && holder.t !== "self") return "deliver";
  if (want.custody?.kind === "venue") return "earn";
  if (spend.custody?.kind === "position") return "exit";
  if (spend.asset && want.asset && !sameSel(spend.asset, want.asset)) return "convert";
  if (spend.asset && (want.network || spend.network) && moves) return "relocate";
  return null;
}

/** A move that keeps the same value in the person's custody on one network (wallet to venue, or venue to wallet). */
function custodyMove(kind: GoalKind, spend: Side, want: Side, holder: Holder): boolean {
  // "move my arbitrum usdc to base": the same token to the person's own account on another network (repo GOA025).
  if (kind === "relocate") return holder.t === "self" && (!want.asset || (spend.asset !== undefined && sameSel(spend.asset, want.asset)));
  if (spend.network && want.network && spend.network !== want.network) return false;
  if (kind === "exit") return !want.network || want.network === spend.network;
  if (kind !== "earn") return false;
  return !want.asset || want.venue !== undefined;
}

export function sameSel(a: AssetSel, b: AssetSel): boolean {
  if ("symbol" in a && "symbol" in b) return a.symbol.toUpperCase() === b.symbol.toUpperCase();
  if ("class" in a && "class" in b) return a.class === b.class;
  return false;
}

/**
 * F4: a bare word where a recipient goes ("pay toly 1 SOL", "send 5 USDC to
 * vitalik") is a nickname: never looked up, always asked. Only lower-case
 * words of 2 to 24 letters, and only after a deliver verb or its "to".
 */
function nicknames(tokens: readonly Token[]): Token[] {
  const verb = tokens.find((token) => token.t === "VERB");
  if (!verb || verb.t !== "VERB" || !DELIVER_KINDS.has(verb.verb.kind)) return [...tokens];
  const verbIndex = tokens.indexOf(verb);
  return tokens.map((token, index) => {
    if (token.t !== "NOISE" || !/^[a-z][a-z-]{1,23}$/u.test(token.raw)) return token;
    const before = tokens[index - 1];
    const afterVerb = index === verbIndex + 1;
    const afterTo = before?.t === "CONN" && before.word === "to";
    if (!afterVerb && !afterTo) return token;
    return { t: "HOLDER", holder: "nickname", raw: token.raw, span: token.span } satisfies Token;
  });
}
