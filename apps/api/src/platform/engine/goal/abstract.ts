/**
 * Abstract goal vocabulary (intent design A.2 "Vocabulary for abstract
 * goals", A.6, package P4-M4, U2 RF5/RF12). Two kinds of reading, both
 * deterministic and both recorded by a named rule (`abstract:<id>`):
 *
 * - rewrites: an idiom that says a concrete action in other words is put
 *   into the words the frames already read ("fund alice.eth with 25 usdc"
 *   -> "send 25 usdc to alice.eth"; "pay rent of 500 usdc to ..." -> "pay
 *   500 usdc to ..."; "safely" / "cheaply" -> a preference). Every word the
 *   rewrite removes is covered by its rule; amounts, tokens, networks,
 *   names and addresses are copied byte for byte, never changed.
 * - abstract frames: a goal only the solver can place (rebalance, ensure,
 *   exposure, exit-all) is built straight into the A.6 IR (`targets`,
 *   `want.mode`, asset classes, position custody). The solver computes and
 *   confirms every move (moves confirms); nothing here plans.
 *
 * Fail closed: a pattern matches the whole clause or not at all; a token or
 * network word it cannot resolve leaves the clause unread (null).
 */
import type { AssetSel, ExposureAssetClass, Goal, GoalPreference, NetworkKey, VenueCategory } from "@kletia/core";
import { canonicalOn, lane, NETWORK_ORDER } from "../clarify/catalog.js";
import { resolveNetworkName } from "../grammar.js";
import type { ReadGoal } from "./frames.js";
import { CLASS_WORDS } from "./lexicon.js";

/** A rewrite: the text the frames read instead, the rule that consumed the words, and what the idiom adds. */
export interface AbstractRewrite {
  readonly text: string;
  readonly rules: readonly string[];
  readonly prefer?: GoalPreference;
}

const AMOUNT = String.raw`\$?\d[\d,]*(?:\.\d+)?|\.\d+`;
const WORD = String.raw`[a-z][a-z0-9.]{0,15}`;
const RECIPIENT = String.raw`\S+\.(?:eth|sns|sol)|0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}`;

/** Trailing manner adverbs that say a preference ("put my idle stables to work safely", "get usdc onto solana cheaply"). */
const MANNER: Readonly<Record<string, GoalPreference>> = Object.freeze({ safely: "safest", cheaply: "cheapest", cheap: "cheapest" });

/** Payment purposes said before the amount ("pay rent of 500 usdc to ..."): the purpose is not a token or a venue. */
const PAYMENT_PURPOSE = String.raw`(?:the\s+)?(?:rent|bill|bills|invoice|salary|wage|wages|fee|fees|debt|loan|deposit)`;

const REWRITES: readonly { readonly id: string; readonly pattern: RegExp; readonly to: string; readonly prefer?: GoalPreference }[] = [
  // "fund alice.eth with 25 usdc on base": a payment to that recipient.
  { id: "fund", pattern: new RegExp(String.raw`^fund\s+(?<who>${RECIPIENT})\s+with\s+(?<rest>(?:${AMOUNT})\s+.+)$`, "iu"), to: "" },
  // "pay rent of 500 usdc to 0x...": the purpose words are dropped by this rule, the payment is read as said.
  { id: "paymentPurpose", pattern: new RegExp(String.raw`^(?<verb>pay|send)\s+${PAYMENT_PURPOSE}\s+(?:of\s+)?(?<rest>(?:${AMOUNT})\s+.+)$`, "iu"), to: "$<verb> $<rest>" },
  // "make sure alice.eth gets exactly 50 usdc on arbitrum": an exact transfer of the stated amount (the transfer is exact).
  {
    id: "exactly",
    pattern: new RegExp(String.raw`^make\s+sure\s+(?<who>${RECIPIENT})\s+(?:gets|receives)\s+exactly\s+(?<amount>${AMOUNT})\s+(?<asset>${WORD})(?<tail>(?:\s+on\s+[a-z][a-z -]{1,24})?)$`, "iu"),
    to: "send $<amount> $<asset> to $<who>$<tail>",
  },
  // "earn the highest apy on my usdc on arbitrum", "give me the safest yield on my usdc": a deposit at the venue the solver ranks.
  {
    id: "bestYield",
    pattern: /^(?:earn|get|give\s+me|find\s+me)\s+the\s+(?<best>highest|best|safest)\s+(?:apy|yield|rate|interest)\s+(?:on|for)\s+(?<what>.+)$/iu,
    to: "put $<what> into the best yield",
  },
  // "send alice.eth enough eth for gas on arbitrum": a payment whose amount was not said (asked, never guessed).
  {
    id: "enoughFor",
    pattern: new RegExp(String.raw`^(?<verb>send|give)\s+(?<who>${RECIPIENT})\s+enough\s+(?<asset>${WORD})\s+for\s+(?:gas|fees)(?<tail>(?:\s+on\s+[a-z][a-z -]{1,24})?)$`, "iu"),
    to: "$<verb> a bit of $<asset> to $<who>$<tail>",
  },
  // "unwrap my weth on base", "wrap 0.1 eth on base": the 1:1 wrap step, read as the swap it is (B.3 wrap venue).
  { id: "unwrap", pattern: /^unwrap\s+(?<what>(?:my\s+|all\s+(?:my\s+)?|\S+\s+)?weth)(?<tail>(?:\s+on\s+[a-z][a-z -]{1,24})?)$/iu, to: "swap $<what> to eth$<tail>" },
  { id: "wrap", pattern: /^wrap\s+(?<what>(?:my\s+|all\s+(?:my\s+)?|\S+\s+)?eth)(?<tail>(?:\s+on\s+[a-z][a-z -]{1,24})?)$/iu, to: "swap $<what> to weth$<tail>" },
  // "max out my aave position on base": everything into that venue; the token is asked when the clause does not say it.
  { id: "maxOut", pattern: /^max\s+out\s+my\s+(?<venue>[a-z][a-z0-9-]{1,20})\s+position(?<tail>(?:\s+on\s+[a-z][a-z -]{1,24})?)$/iu, to: "deposit everything into $<venue>$<tail>" },
];

/**
 * An abstract idiom put into the words the frames read, or null. The manner
 * adverbs ("safely", "cheaply") are read first and become the preference.
 */
export function abstractRewrite(text: string): AbstractRewrite | null {
  let current = text.trim();
  const rules: string[] = [];
  let prefer: GoalPreference | undefined;
  const manner = /\s+(?<word>safely|cheaply|cheap)$/iu.exec(current);
  if (manner?.groups) {
    prefer = MANNER[(manner.groups.word as string).toLowerCase()];
    current = current.slice(0, manner.index).trim();
    rules.push("abstract:manner");
  }
  for (const rewrite of REWRITES) {
    const match = rewrite.pattern.exec(current);
    if (!match?.groups) continue;
    const groups = match.groups;
    if (rewrite.id === "fund") {
      // "with 25 usdc on base": the amount and the token, then the rest as typed.
      current = (groups.rest as string).replace(new RegExp(String.raw`^(?<amount>(?:${AMOUNT})\s+${WORD})(?<tail>.*)$`, "iu"), `send $<amount> to ${groups.who as string}$<tail>`);
      if (!current.startsWith("send ")) return null;
    } else {
      current = rewrite.to.replace(/\$<(?<name>[a-z_]+)>/gu, (_all, name: string) => groups[name] ?? "").replace(/\s+/gu, " ").trim();
    }
    if (rewrite.id === "bestYield") {
      const best = (groups.best as string).toLowerCase();
      if (best === "safest") prefer = "safest";
      // "my usdc" with no network is not all of every holding (C11): the amount is asked.
      if (!/\son\s+\S+/iu.test(groups.what as string)) current = current.replace(/^put\s+my\s+/iu, "put ");
    }
    rules.push(`abstract:${rewrite.id}`);
    break;
  }
  if (rules.length === 0) return null;
  return { text: current, rules, ...(prefer ? { prefer } : {}) };
}

/* ------------------------------------------------------------ frames */

function network(word: string | undefined): NetworkKey | null {
  if (!word) return null;
  const said = resolveNetworkName(word.toLowerCase());
  return said && lane(said) === "mainnet" ? said : null;
}

/** The one mainnet network that lists a token ("sol" -> solana), else null. */
function home(symbol: string): NetworkKey | null {
  const homes = NETWORK_ORDER.filter((key) => lane(key) === "mainnet" && canonicalOn(key, symbol) !== null);
  return homes.length === 1 ? (homes[0] as NetworkKey) : null;
}

/** A listed token on some mainnet network, as typed, or a class word ("stables"). */
function assetOf(word: string): AssetSel | null {
  const lower = word.toLowerCase();
  const cls = CLASS_WORDS[lower];
  if (cls && cls !== "gas") return { class: cls };
  return NETWORK_ORDER.some((key) => lane(key) === "mainnet" && canonicalOn(key, word) !== null) ? { symbol: lower } : null;
}

const wallet = (key: NetworkKey) => ({ network: key, custody: { kind: "wallet" as const } });

function frame(goal: Omit<Goal, "holder" | "constraints" | "confidence"> & Partial<Pick<Goal, "holder" | "constraints">>, rule: string, extra: { possessive?: boolean } = {}): ReadGoal {
  return {
    goal: { holder: { t: "self" }, constraints: {}, confidence: "frame", ...goal } as Goal,
    notes: { orderOnly: false, possessive: extra.possessive ?? false, buy: false, sell: false, ofPrevious: false, spans: [], rules: [`abstract:${rule}`] },
  };
}

/** An exposure class (EXPOSURE_ASSET_CLASSES) as the asset wanted: the solver reads it; core lists it apart until it joins ASSET_CLASSES. */
const exposure = (cls: ExposureAssetClass): AssetSel => ({ class: cls }) as unknown as AssetSel;

/** Staking exposure words: the liquid staking class of the chain's token. */
const STAKING_CLASS: Readonly<Record<string, ExposureAssetClass>> = Object.freeze({ eth: "eth-lst", ethereum: "eth-lst", ether: "eth-lst", sol: "sol-lst", solana: "sol-lst" });

/** Position categories said before "positions" ("my lending positions"). */
const POSITION_CATEGORY: Readonly<Record<string, VenueCategory>> = Object.freeze({ lending: "lending", staking: "staking", yield: "any", earning: "any", defi: "any" });

/**
 * A clause that names an abstract goal, read into the A.6 IR, or null. The
 * patterns (each the whole clause, case-insensitive):
 * - ensure: "make sure i have enough SOL for fees" (atLeast the fee reserve),
 *   "prepare 100 usdc on optimism (for a payment)" (atLeast that amount),
 *   "top up my arbitrum gas" (an addition; the amount is asked),
 *   "get my sol ready for a payment of 50 usdc on solana" (SOL -> 50 USDC);
 * - earn: "make my sol work (for me)" (the way and the amount are asked);
 * - rebalance: "even out my usdc between base and arbitrum",
 *   "go 100% stablecoins on base";
 * - exposure: "(get (me)) exposure to eth staking (with my base usdc)",
 *   "hold btc on base";
 * - exit-all: "exit all my lending positions", "close everything on base",
 *   "withdraw all my usdc from everywhere".
 */
export function readAbstract(text: string): ReadGoal | null {
  const clause = text.trim().replace(/\s+/gu, " ");
  let m: RegExpExecArray | null;

  // ensure: "make sure i have enough sol for fees" / "... for gas" (on <network>).
  if ((m = new RegExp(String.raw`^make sure (?:i have|i've got|ive got|i got|there is|theres) enough (?<asset>${WORD})(?: on (?<net>[a-z][a-z ]{1,20}?))? for (?:fees|gas|transaction fees|tx fees)$`, "iu").exec(clause))?.groups) {
    const asset = m.groups.asset as string;
    if (!assetOf(asset) || CLASS_WORDS[asset.toLowerCase()]) return null;
    const at = m.groups.net ? network(m.groups.net) : home(asset);
    if (!at) return null;
    return frame({ kind: "fuel", spend: {}, want: { asset: { symbol: asset.toLowerCase() }, at: wallet(at), mode: "atLeast" } }, "ensure");
  }
  // "top up my arbitrum gas", "top up gas on arbitrum".
  if ((m = /^top up (?:(?:my )?(?<net>[a-z][a-z ]{1,20}?) gas|(?:my )?gas on (?<net2>[a-z][a-z ]{1,20}))$/iu.exec(clause))?.groups) {
    const at = network(m.groups.net ?? m.groups.net2);
    if (!at) return null;
    // "top up" adds to what is there: the amount is asked, never computed from a reserve.
    return frame({ kind: "fuel", spend: {}, want: { asset: { class: "gas" }, at: wallet(at) } }, "ensure");
  }
  // "prepare 100 usdc on optimism (for a payment)", "have 100 usdc ready on optimism".
  if ((m = new RegExp(String.raw`^prepare (?<amount>\d[\d]*(?:\.\d+)?) (?<asset>${WORD}) on (?<net>[a-z][a-z ]{1,20}?)(?: for (?:a |the )?payment)?$`, "iu").exec(clause))?.groups) {
    const asset = assetOf(m.groups.asset as string);
    const at = network(m.groups.net);
    if (!asset || !("symbol" in asset) || !at || canonicalOn(at, asset.symbol) === null) return null;
    return frame({ kind: "relocate", spend: {}, want: { asset, amount: { t: "exact", value: m.groups.amount as string }, at: wallet(at), mode: "atLeast" } }, "ensure");
  }
  // "get my sol ready for a payment of 50 usdc on solana": the paying holding converted into the payment amount there.
  if ((m = new RegExp(String.raw`^get my (?<spend>${WORD}) ready for (?:a |the )?payment of (?<amount>\d[\d]*(?:\.\d+)?) (?<asset>${WORD}) on (?<net>[a-z][a-z ]{1,20})$`, "iu").exec(clause))?.groups) {
    const spend = assetOf(m.groups.spend as string);
    const want = assetOf(m.groups.asset as string);
    const at = network(m.groups.net);
    if (!spend || !want || !("symbol" in spend) || !("symbol" in want) || !at || canonicalOn(at, spend.symbol) === null || canonicalOn(at, want.symbol) === null) return null;
    if (spend.symbol === want.symbol) return null;
    return frame({ kind: "convert", spend: { asset: spend, from: wallet(at) }, want: { asset: want, amount: { t: "exact", value: m.groups.amount as string }, at: wallet(at) } }, "ensure");
  }
  // "make my sol work (for me)": earn with that token; the amount and the way (stake or deposit) are asked.
  if ((m = new RegExp(String.raw`^make my (?<asset>${WORD}) work(?: for me)?$`, "iu").exec(clause))?.groups) {
    const asset = assetOf(m.groups.asset as string);
    if (!asset) return null;
    return frame({ kind: "earn", spend: { asset }, want: {} }, "earn");
  }

  // rebalance, network axis: "even out my usdc between base and arbitrum".
  if ((m = new RegExp(String.raw`^(?:even out|balance|split evenly|spread evenly) my (?<asset>${WORD}) (?:between|across) (?<a>[a-z][a-z ]{1,20}?) and (?<b>[a-z][a-z ]{1,20})$`, "iu").exec(clause))?.groups) {
    const asset = assetOf(m.groups.asset as string);
    const a = network(m.groups.a);
    const b = network(m.groups.b);
    if (!asset || !a || !b || a === b) return null;
    return frame({ kind: "rebalance", spend: { asset }, want: {}, targets: { axis: "network", weights: [{ key: a, bps: 5_000 }, { key: b, bps: 5_000 }] } }, "rebalance");
  }
  // rebalance, asset axis: "go 100% stablecoins on base", "go all stables on base".
  if ((m = new RegExp(String.raw`^go (?:100 ?%|100 percent|all|fully|all in on) (?:in )?(?<asset>${WORD})(?: on (?<net>[a-z][a-z ]{1,20}))?$`, "iu").exec(clause))?.groups) {
    const asset = assetOf(m.groups.asset as string);
    const at = network(m.groups.net);
    if (!asset || !at) return null;
    const key = "class" in asset ? (asset.class === "usd-stable" ? "any-stable" : asset.class) : asset.symbol.toUpperCase();
    return frame({ kind: "rebalance", spend: {}, want: {}, targets: { axis: "asset", scope: wallet(at), weights: [{ key, bps: 10_000 }] } }, "rebalance");
  }

  // exposure: "get (me) exposure to eth staking (with my base usdc)".
  if ((m = new RegExp(String.raw`^(?:get (?:me )?|i want |want |give me )?exposure to (?<chain>eth|ethereum|ether|sol|solana) staking(?: (?:with|using) my (?:(?<net>[a-z][a-z ]{1,20}?) )?(?<spend>${WORD}))?$`, "iu").exec(clause))?.groups) {
    const cls = STAKING_CLASS[(m.groups.chain as string).toLowerCase()] as ExposureAssetClass;
    const spendAsset = m.groups.spend ? assetOf(m.groups.spend) : null;
    if (m.groups.spend && !spendAsset) return null;
    const from = m.groups.net ? network(m.groups.net) : null;
    if (m.groups.net && !from) return null;
    // "my base usdc" here is the holding that pays, not all of it (C11): the amount stays open and is asked.
    return frame({ kind: "acquire", spend: { ...(spendAsset ? { asset: spendAsset } : {}), ...(from ? { from: wallet(from) } : {}) }, want: { asset: exposure(cls) } }, "exposure");
  }
  // "hold btc on base", "get exposure to btc on base": the bitcoin Kletia lists there (class btc).
  if ((m = /^(?:hold|get exposure to|exposure to) (?:btc|bitcoin)(?: on (?<net>[a-z][a-z ]{1,20}))?$/iu.exec(clause))) {
    const at = m.groups?.net ? network(m.groups.net) : null;
    if (m.groups?.net && !at) return null;
    return frame({ kind: "acquire", spend: {}, want: { asset: exposure("btc"), ...(at ? { at: wallet(at) } : {}) } }, "exposure");
  }

  // exit-all: "exit all my lending positions (on base)", "close all my positions".
  if ((m = /^(?:exit|close|unwind|withdraw from) (?:all (?:of )?)?my (?:(?<cat>lending|staking|yield|earning|defi) )?positions(?: on (?<net>[a-z][a-z ]{1,20}))?$/iu.exec(clause))?.groups) {
    const category = m.groups.cat ? POSITION_CATEGORY[m.groups.cat.toLowerCase()] : undefined;
    const at = m.groups.net ? network(m.groups.net) : null;
    if (m.groups.net && !at) return null;
    // "exit my positions" with nothing else is read the same way: every position, each move confirmed.
    return frame({ kind: "exit", spend: { amount: { t: "max" }, from: { ...(at ? { network: at } : {}), custody: { kind: "position", ...(category ? { category } : {}) } } }, want: {} }, "exitAll", { possessive: true });
  }
  // "close everything on base", "exit everything on base".
  if ((m = /^(?:close|exit|unwind) (?:everything|all(?: my positions)?) on (?<net>[a-z][a-z ]{1,20})$/iu.exec(clause))?.groups) {
    const at = network(m.groups.net);
    if (!at) return null;
    return frame({ kind: "exit", spend: { amount: { t: "max" }, from: { network: at, custody: { kind: "position" } } }, want: {} }, "exitAll", { possessive: true });
  }
  // "withdraw all my usdc from everywhere".
  if ((m = new RegExp(String.raw`^(?:withdraw|take out|pull out|pull) (?:all (?:of )?)?my (?<asset>${WORD}) from everywhere$`, "iu").exec(clause))?.groups) {
    const asset = assetOf(m.groups.asset as string);
    if (!asset) return null;
    return frame({ kind: "exit", spend: { asset, amount: { t: "max" }, from: { custody: { kind: "position" } } }, want: {} }, "exitAll", { possessive: true });
  }
  return null;
}

/**
 * Whether a clause is abstract vocabulary (a rewrite or an abstract frame):
 * such a clause is read by the Goal reader only, never by the relaxed
 * sentence shapes, so no shape reads part of it and drops the rest.
 */
export function abstractClause(text: string): boolean {
  return abstractRewrite(text) !== null || readAbstract(text) !== null;
}
