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
import type { AmountSel, AssetSel, Custody, Goal, GoalKind, Holder, NetworkKey, Place, ProtocolId } from "@kletia/core";
import { getProtocol } from "@kletia/core";
import type { Span, Token, VenueReading } from "./lexer.js";
import type { VerbEntry } from "./lexicon.js";

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
  previous?: boolean;
  venue?: VenueReading;
}

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
export function readFrame(input: readonly Token[], ctx: FrameContext): ReadGoal | null {
  if (input.length === 0) return null;
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

  const spend: Side = {};
  const want: Side = {};
  let holder: Holder = { t: "self" };
  let holderSaid = false;
  let place: NetworkKey | undefined;
  let orderOnly = false;
  let typo: GoalNotes["typo"];
  const via: ProtocolId[] = [];
  let prefer: "cheapest" | "fastest" | "safest" | undefined;
  let conn: string | undefined;
  let pending: Extract<Token, { t: "AMOUNT" }> | undefined;
  let possessive = false;
  let determiner = false;
  const object: Role = verb?.object ?? "spend";
  const other: Role = object === "spend" ? "want" : "spend";
  const side = (role: Role) => (role === "spend" ? spend : want);
  const spans: Span[] = [];
  const worth = verbIndex >= 0 ? worthPhrase(tokens, verbIndex) : null;
  // The worth reading is still confirmed before planning: it is not what the words say in order.
  if (worth) orderOnly = true;

  const bindAmount = (role: Role, token: Extract<Token, { t: "AMOUNT" }>): boolean => {
    const target = side(role);
    if (target.amount) return false;
    target.amount = token.sel;
    if (token.sel.t === "exact") target.amountRaw = token.raw;
    if (token.rewritten && token.sel.t === "exact") target.rewritten = { from: chipWords(token.raw), to: token.readAs ?? token.sel.value };
    spans.push(token.span);
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
    spans.push(span);
    if (pending && (conn === undefined || conn === "of" || WITH_CONNECTORS.has(conn ?? "") || TO_CONNECTORS.has(conn ?? ""))) {
      if (!bindAmount(role, pending)) return false;
      pending = undefined;
    }
    if (determiner && ctx.previousExists && role === "spend" && !target.amount) {
      target.amount = { t: "previous" };
      target.previous = true;
    }
    if (possessive && role === "spend" && !target.amount) {
      target.amount = { t: "max" };
      target.possessive = true;
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
    } else if (conn !== undefined && (conn === "to" || conn === "onto" || conn === "into")) {
      if (want.network) return false;
      want.network = network;
    } else if (conn !== undefined && PLACE_CONNECTORS.has(conn)) {
      if (place && place !== network) return false;
      place = network;
    } else if (conn === undefined) {
      if (possessive || (next?.t === "CONN" && (next.word === "to" || next.word === "onto"))) {
        if (spend.network) return false;
        spend.network = network;
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
    if (index === verbIndex) {
      conn = undefined;
      continue;
    }
    switch (token.t) {
      case "CONN":
        if (token.word === "and" || token.word === "then") return null;
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
        if (role !== "spend" || spend.amount) return null;
        spend.amount = { t: "previous" };
        spend.previous = true;
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
        const role = assetRole(index);
        if (!role) return null;
        if (!placeAssetLike(role, { symbol: token.symbol }, token.span)) return null;
        if (token.venue && role === "want" && token.venue.provider) side(role).venue = token.venue;
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
        if (pending) {
          // "25 base"? An amount must be followed by its asset or a connector.
          if (!bindAmount(object, pending)) return null;
          pending = undefined;
        }
        if (!placeNetwork(index, token.network, token.span)) return null;
        possessive = possessive && tokens[index + 1]?.t === "ASSET";
        conn = undefined;
        continue;
      case "VENUE": {
        spans.push(token.span);
        const venue = token.venue;
        const exitVerb = verb?.kind === "exit";
        const positionNext = tokens[index + 1]?.t === "POSITION" || (tokens[index + 1]?.t === "ASSET" && tokens[index + 2]?.t === "POSITION");
        if (conn === "out of" || conn === "from" || ((conn === undefined || conn === "in" || conn === "on") && (exitVerb || possessive) && !venue.best) || positionNext) {
          if (spend.venue || venue.best) return null;
          spend.venue = venue;
          spend.custody = positionCustody(venue);
          // "my aave USDC": the possessive carries over to the asset after the venue; "my aave position" is all of it.
          if (tokens[index + 1]?.t !== "ASSET") {
            if (possessive && !spend.amount) {
              spend.amount = { t: "max" };
              spend.possessive = true;
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
  if (place && object === "want" && !want.network && !spend.asset) {
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

  // F9 without a word: "..., bridge to base" / "and earn yield" after a step continues with its output.
  const implicit = ctx.previousExists && ctx.chainable !== false && object === "spend" && !spend.asset && !spend.amount && !spend.venue && verb !== undefined;
  if (implicit) {
    spend.amount = { t: "previous" };
    spend.previous = true;
  }
  // "move everything to base": all of every asset, a sweep only the solver can plan.
  const sweep = !spend.asset && !spend.venue && spend.amount?.t === "max" && !ctx.previousExists && (verb?.kind === "relocate" || verb?.kind === "deliver");
  const kind = sweep ? "consolidate" : goalKind(verb, spend, want, holderSaid, holder, { work, ...(verbToken ? { verbWord: verbToken.raw.toLowerCase() } : {}) });
  if (!kind) return null;
  if (verb?.whole && !spend.amount) spend.amount = { t: "max" };
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
      ...(worth ? { worthIdiom: true as const } : {}),
      spans,
    },
  };
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
