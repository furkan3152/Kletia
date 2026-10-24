/**
 * The hand-off reader (round 9): sentences the intent graph does not plan,
 * read into the starting state of the surface that runs them. Perps trades
 * ("long ETH 5x with 100 USDC", "close my ETH long"), native orders ("sell 1
 * WETH at 4000 on base", "buy SOL with 500 USDC over 10 days", "cancel order
 * <id>") and automations ("buy $50 of ETH every Monday", "if SOL drops below
 * 120 sell half", "keep my USDC in the best yield", "when USDC arrives,
 * deposit it into aave") and prediction markets ("bet $20 on yes for <market>",
 * "sell my Trump shares", "what are the odds of X?", round 10).
 *
 * Deterministic and closed: each family is a fixed set of shapes, every word
 * of the sentence must be read (a leftover word means the sentence is not
 * read as a hand-off), and nothing is filled in here. What the sentence did
 * not say stays absent; decide.ts asks for it or shows the default it uses.
 * Returns null for any other sentence (the intent reader handles it).
 */
import { DRIFT_V2_SOLANA, GMX_V2_MARKETS, HYPERLIQUID_MAINNET, PREDICTION_LIMITS, REVIEWED_FILLERS, type NetworkKey, type PerpsVenueId, type ThreadHandoff, type Weekday } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { normalizeText, resolveNetworkName } from "../grammar.js";
import { knownSymbol } from "../clarify/catalog.js";
import { dropFillers } from "../goal/closedClass.js";

/* ------------------------------------------------------------ fragments */

/** A decimal as people type it (thousands commas allowed, never a decimal comma). */
const NUM = "(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?|\\.\\d+";
const SYM = "[a-z][a-z0-9.]{0,15}";
const NET = "(?:arbitrum(?:\\s+one)?|base|ethereum|solana|optimism|op\\s+mainnet|polygon(?:\\s+pos)?)";
const UNIT = "(?<unit>minute|hour|day|week|month)s?";
const WEEKDAY_WORDS: Readonly<Record<string, Weekday>> = Object.freeze({
  monday: "mon", mon: "mon", tuesday: "tue", tue: "tue", tues: "tue", wednesday: "wed", wed: "wed",
  thursday: "thu", thu: "thu", thurs: "thu", friday: "fri", fri: "fri", saturday: "sat", sat: "sat", sunday: "sun", sun: "sun",
});
const WEEKDAY = `(?:${Object.keys(WEEKDAY_WORDS).sort((a, b) => b.length - a.length).join("|")})`;

/** Perps markets Kletia lists on any venue (the scorer and prepare check the venue's own list). */
export const PERPS_MARKETS: readonly string[] = Object.freeze([
  ...new Set([...GMX_V2_MARKETS.map((pin) => pin.symbol), ...HYPERLIQUID_MAINNET.markets, ...Object.keys(DRIFT_V2_SOLANA.perpMarkets)]),
]);
const PERPS_VENUE_WORDS: readonly { readonly pattern: RegExp; readonly venue: PerpsVenueId }[] = [
  { pattern: /^gmx(?:\s*v2)?$/iu, venue: "gmx-v2" },
  { pattern: /^hyperliquid$/iu, venue: "hyperliquid" },
  { pattern: /^drift(?:\s*v2)?$/iu, venue: "drift-v2" },
];
const PERPS_VENUE = "gmx(?:\\s*v2)?|hyperliquid|drift(?:\\s*v2)?";

const issues = (message: string) => [{ path: "text", message: message.slice(0, 160) }];

function refuse(message: string): PlatformError {
  return new PlatformError("INTENT_UNSUPPORTED", message, 422, issues(message));
}

function marketRefusal(message: string): PlatformError {
  return new PlatformError("PERPS_MARKET_UNSUPPORTED", message, 422, issues(message));
}

function leverageRefusal(message: string): PlatformError {
  return new PlatformError("PERPS_LEVERAGE_TOO_HIGH", message, 422, issues(message));
}

/** A typed decimal ("1,250.5" -> "1250.5"); refused when it is zero. */
export function decimalOf(raw: string): string {
  let value = raw.trim().replace(/^\$/u, "").replace(/,/gu, "");
  if (value.startsWith(".")) value = `0${value}`;
  if (!/^\d+(?:\.\d+)?$/u.test(value) || /^0+(?:\.0+)?$/u.test(value)) throw refuse(`"${raw.slice(0, 24)}" is not a positive amount.`);
  return value.replace(/^0+(?=\d)/u, "");
}

function network(raw: string | undefined): NetworkKey | undefined {
  return raw ? resolveNetworkName(raw) ?? undefined : undefined;
}

/** Words that may stand around a reading without changing it. */
const FILLER = /^(?:now|right\s+now|please|position|positions|trade|perp|perps|perpetual|perpetuals)$/iu;

/**
 * Removes each modifier pattern once from `rest` (any order); returns the groups read, or null when a word is left
 * that no pattern read (the sentence is then not this family's).
 */
function modifiers(rest: string, patterns: readonly RegExp[]): Record<string, string | undefined> | null {
  let left = ` ${rest.trim()} `;
  const groups: Record<string, string | undefined> = {};
  for (const pattern of patterns) {
    const match = pattern.exec(left);
    if (!match) continue;
    Object.assign(groups, Object.fromEntries(Object.entries(match.groups ?? {}).filter(([, value]) => value !== undefined)));
    left = `${left.slice(0, match.index)} ${left.slice(match.index + match[0].length)}`;
  }
  const words = left.trim().split(/\s+/u).filter(Boolean);
  return words.every((word) => FILLER.test(word)) ? groups : null;
}

/* ----------------------------------------------------------------- perps */

const PERPS_MODIFIERS: readonly RegExp[] = [
  new RegExp(`\\s(?:on|via|using|through|at|with)\\s+(?<venue>${PERPS_VENUE})\\s`, "iu"),
  new RegExp(`\\s(?:on|in)\\s+(?<net>${NET})\\s`, "iu"),
  new RegExp(`\\s(?:with|using|putting\\s+up|posting|put\\s+up)\\s+(?<coll>\\$?(?:${NUM}))(?:\\s+(?<collAsset>${SYM}))?(?:\\s+(?:of\\s+)?(?:collateral|margin))?\\s`, "iu"),
  new RegExp(`\\s(?<coll2>\\$?(?:${NUM}))(?:\\s+(?<collAsset2>${SYM}))?\\s+(?:of\\s+)?(?:collateral|margin)\\s`, "iu"),
  new RegExp(`\\s(?:at|with|using|on)?\\s*(?<lev>${NUM})\\s*x(?:\\s+leverage)?\\s`, "iu"),
  new RegExp(`\\s(?:at|with|using)\\s+(?<lev2>${NUM})\\s+leverage\\s`, "iu"),
  new RegExp(`\\sleverage\\s+(?:of\\s+)?(?<lev3>${NUM})x?\\s`, "iu"),
  new RegExp(`\\s(?:for|size|sized|worth|of)?\\s*\\$(?<size>${NUM})(?:\\s+(?:size|notional|position|worth))?\\s`, "iu"),
  new RegExp(`\\s(?:for|size|sized|worth|of)?\\s*(?<size2>${NUM})\\s+(?:usd|dollars)(?:\\s+(?:size|notional|position|worth))?\\s`, "iu"),
];

const OPEN = new RegExp(
  `^(?:(?:go|going|open|opening|take|place|enter)\\s+(?:an?\\s+)?)?(?:(?<lev0>${NUM})\\s*x\\s+)?(?<side>long|short)(?:\\s+(?<lev1>${NUM})\\s*x)?(?:\\s+(?:position|perps?))?\\s+(?:on\\s+)?(?<market>${SYM})(?:\\s+perps?)?(?<rest>(?:\\s.*)?)$`,
  "iu",
);
const CLOSE = new RegExp(
  `^(?:close|exit|flatten|unwind)\\s+(?:out\\s+)?(?:of\\s+)?(?:my|the|our)?\\s*(?:(?<market>${SYM})\\s+(?<side>long|short)|(?<side2>long|short)\\s+(?:on\\s+)?(?<market2>${SYM})|(?<market3>${SYM})\\s+perps?)(?:\\s+(?:position|perps?))?(?<rest>(?:\\s.*)?)$`,
  "iu",
);
const REDUCE = new RegExp(
  `^(?:reduce|decrease|trim|cut|shrink)\\s+(?:my|the|our)?\\s*(?:(?<market>${SYM})\\s+(?<side>long|short)|(?<side2>long|short)\\s+(?:on\\s+)?(?<market2>${SYM}))(?:\\s+(?:position|perps?))?(?:\\s+(?<by>by|to)\\s+(?<amt>\\$?(?:${NUM})|half|\\d{1,3}%)(?:\\s+(?:usd|dollars))?)?(?<rest>(?:\\s.*)?)$`,
  "iu",
);

function perpsMarket(raw: string, sentence: string): string {
  const symbol = raw.toUpperCase();
  if (PERPS_MARKETS.includes(symbol)) return symbol;
  if (symbol === "WETH") return "ETH";
  if (symbol === "WBTC" || symbol === "CBBTC") return "BTC";
  throw marketRefusal(`Kletia lists perps on ${PERPS_MARKETS.join(", ")}; "${raw.slice(0, 16)}" is not one of them (in "${sentence.slice(0, 80)}").`);
}

function perpsVenue(raw: string | undefined): PerpsVenueId | undefined {
  if (!raw) return undefined;
  const value = raw.trim().toLowerCase().replace(/\s+/gu, " ");
  return PERPS_VENUE_WORDS.find((entry) => entry.pattern.test(value))?.venue;
}

function leverageOf(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(decimalOf(raw));
  if (!Number.isFinite(value) || value < 1) throw leverageRefusal("Leverage is 1x or more.");
  return value;
}

function readPerpsModifiers(rest: string, sentence: string): Record<string, unknown> | null {
  const g = modifiers(rest, PERPS_MODIFIERS);
  if (!g) return null;
  const collAsset = g.collAsset ?? g.collAsset2;
  const coll = g.coll ?? g.coll2;
  if (coll && collAsset && !["usdc", "usd", "dollars", "dollar"].includes(collAsset.toLowerCase())) {
    throw marketRefusal(`Perps collateral is USDC on every venue Kletia builds for; "${collAsset.slice(0, 16)}" is not taken (in "${sentence.slice(0, 80)}").`);
  }
  const leverage = leverageOf(g.lev ?? g.lev2 ?? g.lev3);
  const size = g.size ?? g.size2;
  return {
    ...(coll ? { collateral: decimalOf(coll), ...(collAsset?.toLowerCase() === "usdc" ? { collateralAsset: "USDC" } : {}) } : {}),
    ...(size ? { sizeUsd: decimalOf(size) } : {}),
    ...(leverage !== undefined ? { leverage } : {}),
    ...(g.venue ? { venue: perpsVenue(g.venue) } : {}),
    ...(network(g.net) ? { network: network(g.net) } : {}),
  };
}

function readPerps(text: string): ThreadHandoff | null {
  const open = OPEN.exec(text);
  if (open?.groups) {
    const g = open.groups;
    const read = readPerpsModifiers(g.rest ?? "", text);
    if (!read) return null;
    // "long term", "short of": a market word must be a symbol; an unknown one is refused only when the rest reads as a trade.
    const listed = PERPS_MARKETS.includes((g.market as string).toUpperCase()) || knownSymbol(g.market as string);
    if (!listed && Object.keys(read).length === 0 && !/^(?:go|going|open|opening|take|place|enter)\s/iu.test(text)) return null;
    const lev0 = leverageOf(g.lev0);
    const lev1 = leverageOf(g.lev1);
    if (lev0 !== undefined && lev1 !== undefined) throw refuse("The sentence names two leverages; say one.");
    const leverage = lev0 ?? lev1;
    if (leverage !== undefined && read.leverage !== undefined && read.leverage !== leverage) throw refuse("The sentence names two leverages; say one.");
    return { surface: "perps", input: { action: "open", side: (g.side as string).toLowerCase(), market: perpsMarket(g.market as string, text), ...read, ...(leverage !== undefined ? { leverage } : {}) } };
  }
  const close = CLOSE.exec(text);
  if (close?.groups) {
    const g = close.groups;
    const market = g.market ?? g.market2 ?? g.market3;
    if (!market || (!PERPS_MARKETS.includes(market.toUpperCase()) && !knownSymbol(market))) return null;
    const read = modifiers(g.rest ?? "", PERPS_MODIFIERS.slice(0, 2));
    if (!read) return null;
    const side = (g.side ?? g.side2)?.toLowerCase();
    return {
      surface: "perps",
      input: { action: "close", market: perpsMarket(market, text), ...(side ? { side } : {}), ...(read.venue ? { venue: perpsVenue(read.venue) } : {}), ...(network(read.net) ? { network: network(read.net) } : {}) },
    };
  }
  const reduce = REDUCE.exec(text);
  if (reduce?.groups) {
    const g = reduce.groups;
    const market = (g.market ?? g.market2) as string;
    if (!PERPS_MARKETS.includes(market.toUpperCase()) && !knownSymbol(market)) return null;
    const read = modifiers(g.rest ?? "", PERPS_MODIFIERS.slice(0, 2));
    if (!read) return null;
    if (g.by?.toLowerCase() === "to") throw refuse("Say how much to take off (\"reduce my SOL short by $100\") or close it; Kletia does not resize to a target.");
    if (g.amt && !/^\$?[\d.,]+$/u.test(g.amt)) throw refuse("Say the dollar size to take off (\"by $100\"), or close the position.");
    return {
      surface: "perps",
      input: {
        action: "decrease", market: perpsMarket(market, text), side: (g.side ?? g.side2 as string).toLowerCase(), ...(g.amt ? { sizeUsd: decimalOf(g.amt) } : {}),
        ...(read.venue ? { venue: perpsVenue(read.venue) } : {}), ...(network(read.net) ? { network: network(read.net) } : {}),
      },
    };
  }
  return null;
}

/* ---------------------------------------------------------------- orders */

const ON_NET = `(?:\\s+(?:on|in)\\s+(?<net>${NET}))?`;
const EXPIRY = `(?:,?\\s+(?:good\\s+for|valid\\s+for|expires?\\s+in|expiring\\s+in|for)\\s+(?<expN>\\d+)\\s+(?<expU>hour|day|week)s?)?`;
/** "at 4000", "@ 0.8", "at $4,000 each", "at a price of 4000 usdc". */
const PRICE = `\\s+(?:at|@)\\s*(?:a\\s+(?:price|limit)\\s+of\\s+)?\\$?(?<price>${NUM})(?:\\s+(?<unit>usdc|usdt|usd|dollars|dai|each|apiece|a\\s+piece|per\\s+(?:${SYM})|${SYM}\\s+each))?`;

const LIMIT_SELL = new RegExp(`^(?:(?:place\\s+an?\\s+)?limit\\s+(?:order\\s+(?:to\\s+)?)?)?(?:sell|swap|convert|trade)\\s+(?<amt>${NUM})\\s+(?<a>${SYM})(?:\\s+(?:for|to|into)\\s+(?<b0>${SYM}))?${PRICE}(?:\\s+(?:for|in|into)\\s+(?<b>${SYM}))?${ON_NET}${EXPIRY}$`, "iu");
const LIMIT_BUY = new RegExp(`^(?:(?:place\\s+an?\\s+)?limit\\s+(?:order\\s+(?:to\\s+)?)?)?buy\\s+(?<amt>${NUM})\\s+(?<b>${SYM})${PRICE}(?:\\s+(?:with|using|in|for)\\s+(?<a>${SYM}))?${ON_NET}${EXPIRY}$`, "iu");
const DCA_OVER = new RegExp(
  `^(?:dca\\s+(?:into\\s+)?)?(?:(?:buy|get|accumulate)\\s+(?<b>${SYM})\\s+(?:with|using)\\s+(?<amt>\\$?(?:${NUM}))(?:\\s+(?<a>${SYM}))?|(?:dca|sell|swap|convert|trade)\\s+(?<amt2>\\$?(?:${NUM}))(?:\\s+(?<a2>${SYM}))?\\s+(?:for|to|into)\\s+(?<b2>${SYM}))` +
    `\\s+(?:over|across|during|in)\\s+(?:the\\s+next\\s+)?(?<count>\\d+)\\s+${UNIT}${ON_NET}$`,
  "iu",
);
const CANCEL = /^cancel\s+(?:my\s+|the\s+|this\s+)?(?:(?:limit|dca|native|recurring)\s+)?orders?(?:\s+(?<id>\S+))?$/iu;

function orderAmountSide(said: string | undefined, a: string | undefined): string | undefined {
  const unit = said?.toLowerCase();
  if (!unit || /^(?:each|apiece|a piece)$/u.test(unit) || unit.endsWith(" each") || unit.startsWith("per ")) return a;
  if (unit === "usd" || unit === "dollars") return a;
  return a && a.toLowerCase() !== unit ? "conflict" : said;
}

function expiresAt(n: string | undefined, unit: string | undefined): Record<string, string> {
  if (!n || !unit) return {};
  const seconds = Number(n) * ({ hour: 3_600, day: 86_400, week: 604_800 } as Record<string, number>)[unit.toLowerCase()]!;
  return { expiresIn: String(seconds) };
}

function readOrders(text: string): ThreadHandoff | null {
  const cancel = CANCEL.exec(text);
  if (cancel?.groups) {
    if (!cancel.groups.id) throw refuse("Say which order: \"cancel order <id>\". \"show my orders\" lists them with their ids.");
    return { surface: "orders", input: { action: "cancel", orderId: cancel.groups.id } };
  }
  for (const [pattern, side] of [[LIMIT_SELL, "sell"], [LIMIT_BUY, "buy"]] as const) {
    const match = pattern.exec(text);
    if (!match?.groups) continue;
    const g = match.groups;
    if (g.b0 && g.b) throw refuse("The order names two tokens to receive; say one.");
    const counter = orderAmountSide(g.unit, side === "sell" ? g.b0 ?? g.b : g.a);
    if (counter === "conflict") throw refuse("The price and the asset paid name different tokens; say one.");
    if (!knownSymbol(side === "sell" ? (g.a as string) : (g.b as string))) return null;
    const input = side === "sell"
      ? { sell: g.a, ...(counter ? { buy: counter } : {}), amountIn: "sell" }
      : { buy: g.b, ...(counter ? { sell: counter } : {}), amountIn: "buy" };
    return {
      surface: "orders",
      input: { action: "create", kind: "limit", ...input, amount: decimalOf(g.amt as string), price: decimalOf(g.price as string), ...(network(g.net) ? { network: network(g.net) } : {}), ...expiresAt(g.expN, g.expU) },
    };
  }
  const dca = DCA_OVER.exec(text);
  if (dca?.groups) {
    const g = dca.groups;
    const amount = (g.amt ?? g.amt2) as string;
    const sell = g.a ?? g.a2;
    const buy = (g.b ?? g.b2) as string;
    if (!knownSymbol(buy) || (sell && !knownSymbol(sell))) return null;
    return {
      surface: "orders",
      input: {
        action: "create", kind: "dca", buy, ...(sell ? { sell } : {}), amount: decimalOf(amount), ...(amount.startsWith("$") ? { usd: true } : {}),
        period: (g.unit as string).toLowerCase(), count: Number(g.count), ...(network(g.net) ? { network: network(g.net) } : {}),
      },
    };
  }
  return null;
}

/** A run's sentence that swaps an exact amount ("buy $50 of ETH", "sell 100 USDC for SOL"), or null. */
export interface TextSwap {
  readonly sell?: string;
  readonly buy?: string;
  readonly amount: string;
  readonly usd?: true;
  readonly network?: NetworkKey;
}

const SWAP_TEXTS: readonly RegExp[] = [
  new RegExp(`^(?:buy|get)\\s+(?<usd>\\$)(?<amt>${NUM})\\s+(?:of|worth\\s+of)\\s+(?<b>${SYM})${ON_NET}$`, "iu"),
  new RegExp(`^(?:buy|get)\\s+(?<b>${SYM})\\s+(?:with|using|for)\\s+(?<usd>\\$)?(?<amt>${NUM})(?:\\s+(?<a>${SYM}))?${ON_NET}$`, "iu"),
  new RegExp(`^(?:sell|swap|convert|trade|exchange)\\s+(?<usd>\\$)?(?<amt>${NUM})(?:\\s+(?<a>${SYM}))?(?:\\s+(?:for|to|into)\\s+(?<b>${SYM}))?${ON_NET}$`, "iu"),
];

export function swapOfText(raw: string): TextSwap | null {
  // Reviewed fillers ("kindly", "pls") read the same as the intent reader reads them.
  const text = handoffText(dropFillers(raw).text);
  for (const pattern of SWAP_TEXTS) {
    const g = pattern.exec(text)?.groups;
    if (!g) continue;
    const usd = g.usd !== undefined;
    if (usd && g.a) return null;
    const sell = g.a ?? (usd ? "USDC" : undefined);
    if ((sell && !knownSymbol(sell)) || (g.b && !knownSymbol(g.b)) || (!sell && !g.b) || (!sell && !usd)) return null;
    return { ...(sell ? { sell: sell.toUpperCase() } : {}), ...(g.b ? { buy: g.b.toUpperCase() } : {}), amount: decimalOf(g.amt as string), ...(usd ? { usd: true as const } : {}), ...(network(g.net) ? { network: network(g.net) } : {}) };
  }
  return null;
}

/* ----------------------------------------------------------- automations */

/** "every day", "every 2 weeks", "every monday", "every month on the 15th", "daily", "each friday at 9am". */
const PERIOD =
  `(?:(?:every|each)\\s+(?:(?<count>\\d+|other)\\s+)?(?<unit>minute|hour|day|week|month)s?(?:\\s+on\\s+the\\s+(?<dom>\\d{1,2})(?:st|nd|rd|th)?)?` +
  `|(?:every|each|on)\\s+(?<weekday>${WEEKDAY})s?|(?<adverb>hourly|daily|weekly|monthly)` +
  `|on\\s+the\\s+(?<dom2>\\d{1,2})(?:st|nd|rd|th)?\\s+of\\s+(?:every|each|the)\\s+month)`;
const AT_TIME = "(?:\\s+at\\s+(?<hour>\\d{1,2})(?::(?<minute>\\d{2}))?\\s*(?<ampm>am|pm)?(?:\\s+(?<tz>utc))?)?";
const RUNS = `(?:\\s+for\\s+(?<forN>\\d+)\\s+(?<forU>minute|hour|day|week|month|time)s?|\\s+(?<times>\\d+)\\s+times)?`;
const SCHEDULE_SUFFIX = new RegExp(`^(?<action>.+?)\\s+${PERIOD}${AT_TIME}${RUNS}$`, "iu");
const SCHEDULE_PREFIX = new RegExp(`^${PERIOD}${AT_TIME}${RUNS},?\\s+(?<action>.+)$`, "iu");

const DIRECTION_WORDS = "drops|dips|falls|goes|gets|trades|is|moves|crosses|rises|climbs|jumps|pumps|breaks|hits|reaches|touches|tanks|dumps";
const PRICE_IF = new RegExp(
  `^(?:if|when|whenever|once|as\\s+soon\\s+as)\\s+(?:the\\s+)?(?:price\\s+of\\s+)?(?<asset>${SYM})(?:\\s+price)?\\s+(?:(?<verb>${DIRECTION_WORDS})\\s+)?(?:(?<rel>below|under|beneath|above|over|past|to|back\\s+(?:above|below))\\s+)?\\$?(?<price>${NUM})(?:\\s+(?:usd|dollars))?\\s*(?:,\\s*|\\s+)(?:then\\s+)?(?<action>.+)$`,
  "iu",
);
const PRICE_SUFFIX = new RegExp(
  `^(?<action>.+?)\\s+(?:if|when|once|as\\s+soon\\s+as)\\s+(?:the\\s+price\\s+of\\s+)?(?<asset>${SYM}|it)(?:\\s+price)?\\s+(?:(?<verb>${DIRECTION_WORDS})\\s+)?(?:(?<rel>below|under|beneath|above|over|past|to)\\s+)?\\$?(?<price>${NUM})(?:\\s+(?:usd|dollars))?$`,
  "iu",
);
const BALANCE_IF = new RegExp(
  `^(?:if|when|whenever|once)\\s+my\\s+(?<asset>${SYM})\\s+balance(?:\\s+on\\s+(?<net>${NET}))?\\s+(?:(?:${DIRECTION_WORDS})\\s+)?(?<rel>below|under|above|over)\\s+(?<amt>${NUM})(?:\\s+on\\s+(?<net2>${NET}))?\\s*(?:,\\s*|\\s+)(?:then\\s+)?(?<action>.+)$`,
  "iu",
);
const INCOMING = new RegExp(
  `^(?:when|whenever|once|every\\s+time|each\\s+time)\\s+(?:(?:i\\s+(?:receive|get))\\s+(?:(?:some|any|new)\\s+)?(?<asset>${SYM})|(?:(?:some|any|new)\\s+)?(?<asset2>${SYM})\\s+(?:arrives|comes\\s+in|lands|is\\s+received|hits\\s+my\\s+wallet))` +
    `(?:\\s+on\\s+(?<net>${NET}))?\\s*(?:,\\s*|\\s+)(?:then\\s+)?(?<action>.+)$`,
  "iu",
);
const BEST_YIELD = new RegExp(
  `^(?:(?:always|automatically|auto)\\s+)?(?:keep|put|park|hold|leave|move)\\s+(?:all\\s+(?:of\\s+)?)?my\\s+(?<asset>${SYM})\\s+(?:in|at|into|to)\\s+(?:the\\s+)?(?:best|highest|top)\\s+(?:yield|apy|rate|lending\\s+rate|interest(?:\\s+rate)?)` +
    `(?:\\s+on\\s+(?<nets>${NET}(?:(?:\\s*,\\s*|\\s+(?:and|or)\\s+)${NET})*))?(?:\\s+(?:automatically|always))?$`,
  "iu",
);

const WORDS_ABOVE = /^(?:rises|climbs|jumps|pumps|breaks)$/iu;
const WORDS_BELOW = /^(?:drops|dips|falls|tanks|dumps)$/iu;

function direction(said: string | undefined, relation: string | undefined): "above" | "below" | undefined {
  const verb = said?.toLowerCase();
  const rel = relation?.toLowerCase();
  if (rel && /(?:below|under|beneath)$/u.test(rel)) return "below";
  if (rel && /(?:above|over|past)$/u.test(rel)) return "above";
  if (verb && WORDS_ABOVE.test(verb)) return "above";
  if (verb && WORDS_BELOW.test(verb)) return "below";
  return undefined;
}

/** A portion said with no asset after a price trigger ("sell half") names the trigger's asset. */
function withAsset(action: string, asset: string): string {
  const bare = /^(?<verb>sell|swap|convert|dump)(?:\s+(?<portion>half|all|everything|it|a\s+quarter|\d{1,3}%))?(?<rest>(?:\s+(?:for|to|into)\s+\S+)?)$/iu.exec(action);
  if (!bare?.groups) return action;
  const said = bare.groups.portion?.toLowerCase();
  const portion = said === "it" || said === "everything" ? "all" : said;
  if (!portion) return action;
  return `${(bare.groups.verb as string).toLowerCase()} ${portion} of my ${asset.toUpperCase()}${bare.groups.rest ?? ""}`;
}

function scheduleTrigger(said: Record<string, string | undefined>): Record<string, unknown> {
  const g = Object.fromEntries(Object.entries(said).map(([key, value]) => [key, key === "action" ? value : value?.toLowerCase()]));
  const adverb = g.adverb ? ({ hourly: "hour", daily: "day", weekly: "week", monthly: "month" } as Record<string, string>)[g.adverb] : undefined;
  const weekday = g.weekday ? WEEKDAY_WORDS[g.weekday] : undefined;
  const dom = g.dom ?? g.dom2;
  const unit = adverb ?? (weekday ? "week" : dom && !g.unit ? "month" : g.unit);
  const count = g.count === "other" ? 2 : g.count ? Number(g.count) : 1;
  let at: string | undefined;
  if (g.hour) {
    let hour = Number(g.hour);
    if (g.ampm === "pm" && hour < 12) hour += 12;
    if (g.ampm === "am" && hour === 12) hour = 0;
    if (hour > 23 || Number(g.minute ?? "0") > 59) throw refuse("That time of day is not valid.");
    at = `${String(hour).padStart(2, "0")}:${g.minute ?? "00"}`;
  }
  const runs = g.times ? Number(g.times) : undefined;
  return {
    kind: "every", unit, ...(count !== 1 ? { count } : {}), ...(weekday ? { weekday } : {}), ...(dom ? { dayOfMonth: Number(dom) } : {}), ...(at ? { at } : {}),
    ...(g.forN ? { forN: Number(g.forN), forU: g.forU } : {}), ...(runs !== undefined ? { maxRuns: runs } : {}),
  };
}

function readAutomation(text: string): ThreadHandoff | null {
  const best = BEST_YIELD.exec(text);
  if (best?.groups && knownSymbol(best.groups.asset as string)) {
    const networks = best.groups.nets ? [...new Set(best.groups.nets.split(/\s*,\s*|\s+(?:and|or)\s+/iu).map((name) => network(name)))] : [];
    return { surface: "automations", input: { trigger: { kind: "best-yield", asset: (best.groups.asset as string).toUpperCase(), ...(networks.length > 0 ? { networks } : {}) }, action: "rebalance" } };
  }
  const price = [PRICE_IF.exec(text), PRICE_SUFFIX.exec(text)].find((match) => match?.groups && (match.groups.asset?.toLowerCase() === "it" || knownSymbol(match.groups.asset as string)));
  if (price?.groups) {
    const g = price.groups;
    const asset = g.asset?.toLowerCase() === "it" ? null : (g.asset as string).toUpperCase();
    if (!asset) throw refuse("Say which asset's price to watch, e.g. \"if SOL drops below 120 sell half\".");
    const dir = direction(g.verb, g.rel);
    return {
      surface: "automations",
      input: { trigger: { kind: "price", asset, priceUsd: decimalOf(g.price as string), ...(dir ? { direction: dir } : {}) }, action: "intent" },
      inner: { text: withAsset((g.action as string).trim(), asset), answers: [] },
    };
  }
  const balance = BALANCE_IF.exec(text);
  if (balance?.groups && knownSymbol(balance.groups.asset as string)) {
    const g = balance.groups;
    const where = network(g.net ?? g.net2);
    return {
      surface: "automations",
      input: { trigger: { kind: "balance", asset: (g.asset as string).toUpperCase(), direction: direction(undefined, g.rel), amount: decimalOf(g.amt as string), ...(where ? { network: where } : {}) }, action: "intent" },
      inner: { text: (g.action as string).trim(), answers: [] },
    };
  }
  const incoming = INCOMING.exec(text);
  if (incoming?.groups) {
    const g = incoming.groups;
    const asset = ((g.asset ?? g.asset2) as string).toUpperCase();
    if (!knownSymbol(asset)) return null;
    const where = network(g.net);
    // "deposit it": each run plans the whole balance of that asset (a run cannot see how much arrived).
    const action = (g.action as string).trim().replace(/\b(?:it|them|that)\b/iu, `all my ${asset}`);
    return {
      surface: "automations",
      input: { trigger: { kind: "incoming", asset, ...(where ? { network: where } : {}) }, action: "intent", ...(action !== (g.action as string).trim() ? { wholeBalance: true } : {}) },
      inner: { text: action, answers: [] },
    };
  }
  const schedule = SCHEDULE_PREFIX.exec(text) ?? SCHEDULE_SUFFIX.exec(text);
  if (schedule?.groups) {
    const g = schedule.groups;
    return { surface: "automations", input: { trigger: scheduleTrigger(g), action: "intent" }, inner: { text: (g.action as string).trim(), answers: [] } };
  }
  return null;
}

/* ----------------------------------------------------------- predictions */

const STAKE = `\\$?(?<amt>${NUM})(?:\\s*(?:usdc|usd|pusd|dollars?|bucks))?`;
const SIDE_WORD = "(?<outcome>yes|no)";
// "stake" and "put" are left out: "stake 1 on lido" and "put 100 usdc on aave" are intents.
const BET_VERB = "(?:bet|wager|place\\s+(?:a\\s+)?bet\\s+of)";
const PREDICTION_TEXTS: readonly { readonly pattern: RegExp; readonly action: "buy" | "sell" }[] = [
  // "bet $20 on yes for <market>", "wager 10 usdc on no in <market>", "bet $20 on <market>" (the outcome is asked)
  { pattern: new RegExp(`^${BET_VERB}\\s+${STAKE}\\s+on\\s+(?:(?:the\\s+)?${SIDE_WORD}(?:\\s+(?:side|shares?))?\\s+(?:for|on|in|of|that)\\s+)?(?<market>.+)$`, "iu"), action: "buy" },
  // "bet $20 that <market>" (yes on it)
  { pattern: new RegExp(`^${BET_VERB}\\s+${STAKE}\\s+(?<that>that)\\s+(?<market>.+)$`, "iu"), action: "buy" },
  // "bet on yes for <market>" (the amount is asked)
  { pattern: new RegExp(`^bet\\s+on\\s+${SIDE_WORD}\\s+(?:for|on|in|that)\\s+(?<market>.+)$`, "iu"), action: "buy" },
  // "buy 50 usdc of no on <market>", "buy $50 worth of yes shares in <market>"
  { pattern: new RegExp(`^buy\\s+${STAKE}\\s+(?:worth\\s+)?(?:of|in)\\s+${SIDE_WORD}(?:\\s+shares?)?\\s+(?:on|for|in|of)\\s+(?<market>.+)$`, "iu"), action: "buy" },
  // "buy yes on <market> for $20"
  { pattern: new RegExp(`^buy\\s+${SIDE_WORD}(?:\\s+shares?)?\\s+(?:on|for|in|of)\\s+(?<market>.+?)\\s+(?:for|with)\\s+${STAKE}$`, "iu"), action: "buy" },
  // "sell my trump shares", "sell all my yes shares on <market>", "sell 50 no shares of <market>"
  { pattern: /^sell\s+(?:all\s+(?:of\s+)?)?my\s+(?:(?<outcome>yes|no)\s+)?(?<market>.+?)\s+(?:shares|bets?|predictions?)$/iu, action: "sell" },
  { pattern: /^sell\s+(?:all\s+(?:of\s+)?)?my\s+(?<outcome>yes|no)\s+(?:shares|bets?)\s+(?:on|in|for|of)\s+(?<market>.+)$/iu, action: "sell" },
  { pattern: new RegExp(`^sell\\s+(?<shares>${NUM})\\s+(?<outcome>yes|no)\\s+shares\\s+(?:on|in|for|of)\\s+(?<market>.+)$`, "iu"), action: "sell" },
];
const ODDS_QUESTIONS: readonly RegExp[] = [
  /^(?:what\s+are|what'?s|whats|what\s+is)\s+the\s+(?:odds|chances?|probability|likelihood)\s+(?:of|that|for|on)\s+(?<q>[^?]+?)\s*\??$/iu,
  /^(?:the\s+)?(?:odds|chances?|probability)\s+(?:of|that|for|on)\s+(?<q>[^?]+?)\s*\??$/iu,
  /^how\s+likely\s+is\s+(?:it\s+that\s+)?(?<q>[^?]+?)\s*\??$/iu,
  /^what\s+(?:does|do)\s+(?:polymarket|the\s+markets?|prediction\s+markets?)\s+(?:say|think)\s+(?:about|of|on)\s+(?<q>[^?]+?)\s*\??$/iu,
  /^(?:show|find|search|look\s+up)\s+(?:me\s+)?(?:the\s+)?(?:prediction\s+)?markets?\s+(?:on|for|about)\s+(?<q>[^?]+?)\s*\??$/iu,
];

/**
 * Words that would change what a trade sentence asks if they were read as part of the market's name: a condition, a
 * time, a negation, an alternative or a hedge ("bet $20 on yes for X if eth goes up"). A trade sentence holding one is
 * refused (the reader never drops them); Predict's search takes any words.
 */
const NEVER_IN_TRADE = /\b(?:if|unless|when|whenever|once|later|tomorrow|tonight|every|daily|weekly|monthly|not|don'?t|dont|never|or|either|maybe|idk|up\s+to|at\s+most|cancel|should|what\s+if)\b/iu;

/** A reviewed filler the filler pass kept at the end ("... 2027 lol": it sits next to a number): never read into a name. */
const TRAILING_FILLERS = new RegExp(
  `\\s(${REVIEWED_FILLERS.filter((entry) => entry.position !== "start").map((entry) => entry.phrase.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|")})$`,
  "iu",
);

/** Market words as said: one clause, no addresses, at most PREDICTION_LIMITS.maxQueryLength characters. */
function marketWords(raw: string): string {
  const text = raw.trim().replace(/^(?:the\s+)?(?:market\s+)?(?:on\s+|for\s+|about\s+)?/iu, "").replace(/[\s?.!,]+$/u, "").trim();
  if (!text) throw refuse("Say which market, e.g. \"bet $20 on yes for <market words>\".");
  if (/0x[0-9a-f]{6,}|[1-9A-HJ-NP-Za-km-z]{32,44}/iu.test(text) || /(?:^|\s)(?:and\s+then|then|after\s+that|also)\s/iu.test(text)) {
    throw refuse("One prediction per sentence, named by its words alone (no addresses or second steps).");
  }
  if (text.length > PREDICTION_LIMITS.maxQueryLength) throw refuse(`Name the market in at most ${PREDICTION_LIMITS.maxQueryLength} characters.`);
  return text;
}

/** A question about odds: the Predict view opens its search with the words (nothing is planned). */
function readOddsQuestion(raw: string): ThreadHandoff | null {
  const text = dropFillers(raw.trim().replace(/\s+/gu, " ")).text;
  for (const pattern of ODDS_QUESTIONS) {
    const query = pattern.exec(text)?.groups?.q;
    if (query) return { surface: "predictions", input: { action: "search", query: marketWords(query) } };
  }
  return null;
}

function readPredictions(said: string): ThreadHandoff | null {
  // Reviewed fillers ("lol", "rn") read the same as the intent reader reads them.
  const text = handoffText(dropFillers(said).text);
  for (const { pattern, action } of PREDICTION_TEXTS) {
    const g = pattern.exec(text)?.groups;
    if (!g) continue;
    const query = marketWords(g.market as string);
    if (/^(?:yes|no)$/iu.test(query)) throw refuse("Say which market, e.g. \"bet $20 on yes for <market words>\".");
    const word = NEVER_IN_TRADE.exec(query)?.[0] ?? TRAILING_FILLERS.exec(query)?.[1];
    if (word) throw refuse(`"${word}" would change this trade, and Kletia does not read it into a market's name. Open Predict to search for the market, then trade it there.`);
    const outcome = g.outcome ? (g.outcome.toLowerCase() === "yes" ? "Yes" : "No") : g.that ? "Yes" : undefined;
    if (action === "sell") {
      return { surface: "predictions", input: { action: "sell", query, ...(outcome ? { outcome } : {}), ...(g.shares ? { shares: decimalOf(g.shares) } : {}) } };
    }
    return { surface: "predictions", input: { action: "buy", query, ...(outcome ? { outcome } : {}), ...(g.that ? { saidThat: true } : {}), ...(g.amt ? { amountUsd: decimalOf(g.amt) } : {}) } };
  }
  return null;
}

/* ------------------------------------------------------------------ entry */

/** The text the hand-off reader reads: the grammar's normal form with single spaces, in its own case (addresses, ids). */
export function handoffText(text: string): string {
  return normalizeText(text).replace(/\s+/gu, " ").trim();
}

/**
 * Reads a sentence as a hand-off, or returns null when it is no perps trade,
 * native order, automation or prediction. Throws INTENT_UNSUPPORTED (or the surface's
 * code) for a hand-off sentence that cannot be taken as said.
 */
export function readHandoff(raw: string): ThreadHandoff | null {
  if (raw.length <= 300) {
    const odds = readOddsQuestion(raw);
    if (odds) return odds;
  }
  if (/[?¿？]\s*$/u.test(raw.trim())) return null;
  const text = handoffText(raw);
  if (!text || text.length > 300) return null;
  return readPredictions(text) ?? readPerps(text) ?? readOrders(text) ?? readAutomation(text);
}
