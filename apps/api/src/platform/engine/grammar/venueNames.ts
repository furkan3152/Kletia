/**
 * Borrow refusals, venue-less deposits and venue names read from the
 * text.
 */
import {
  capabilityIndex,
  capableProtocols,
  CHAINS,
  findAssetBySymbol,
  YIELD_VENUES,
  type ProtocolId,
} from "@kletia/core";
import { PlatformError, unsupported } from "../../errors.js";
import { GRAMMAR_EXAMPLES } from "./examples.js";
import {
  GRAMMAR_VENUE_WORDS,
  LENDING_VENUES,
  VAULT_PROTOCOLS,
} from "./venues.js";
import { protocolName, resolveNetworkName } from "./types.js";
import { AMOUNT, ASSET, ON_NETWORK } from "./patterns.js";

/* ------------------------------------------- refusals that say what works */

/** Lending and savings protocols of the capability index ("Aave V3, Compound V3, ... or Kamino"), for refusal texts. */
export const LENDING_NAMES: string = (() => {
  const names = capableProtocols("deposit").map(protocolName);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}` : names[0] ?? "a lending venue";
})();

/** Verbs of lending actions Kletia does not run yet (`borrow` / `repay` exist in IntentActionKind, nothing executes them). */
export const BORROW_VERBS: readonly string[] = Object.freeze(["borrow", "repay"]);

/** "borrow ...": refused with what Kletia can do instead (never a silent failure). */
export function borrowRefusal(clause: string, verb: string): PlatformError {
  const message = verb === "repay"
    ? "Repaying a loan is not available yet (\"repay\" is not a supported action); Kletia does not open or manage loans."
    : "Borrowing is not available yet (\"borrow\" is not a supported action); Kletia can deposit as collateral, e.g. \"deposit 100 USDC into aave on base\".";
  return unsupported(message, GRAMMAR_EXAMPLES, [{ path: "text", message: `Could not interpret "${clause.slice(0, 120)}".` }]);
}

const VENUELESS_DEPOSIT = new RegExp(
  `^(?:deposit|supply|lend)\\s+${AMOUNT}(?:\\s+${ASSET("a")})?${ON_NETWORK}?$`,
  "iu",
);

/**
 * A deposit that names no venue ("deposit 100 USDC on base"): the strict
 * grammar never picks a venue for the user, so it refuses, naming the venues
 * that take that asset on that network (capability index) and one sentence
 * that works. The clarify layer asks the same as a VENUE_MISSING question.
 */
export function venuelessDeposit(clause: string): PlatformError | null {
  const match = VENUELESS_DEPOSIT.exec(clause);
  if (!match?.groups) return null;
  const asset = match.groups.a;
  const network = match.groups.net ? resolveNetworkName(match.groups.net) : null;
  // The registry symbol on that network (USDT is USDT0 on Arbitrum One and Polygon PoS).
  const listed = (symbol: string | undefined) => (symbol && network ? findAssetBySymbol(network, symbol)?.symbol ?? symbol : symbol);
  const lookup = (symbol: string | undefined) => capabilityIndex(network ?? undefined, "deposit", listed(symbol)).filter((row) => row.asset !== null);
  // Ether is deposited as WETH on EVM venues.
  const rows = lookup(asset).length > 0 || asset?.toUpperCase() !== "ETH" ? lookup(asset) : lookup("WETH");
  const protocols = [...new Set(rows.map((row) => row.protocol))];
  const where = network ? ` on ${CHAINS[network].name}` : "";
  const what = asset ? `${asset} deposits` : "Deposits";
  const verb = (clause.split(/\s+/u)[0] ?? "deposit").toLowerCase();
  const first = rows[0];
  const example = protocols[0] && first
    ? ` e.g. "${verb} ${match.groups.amt ?? "100"} ${asset ?? first.asset} into ${venueWordOf(protocols[0])} on ${first.network}".`
    : "";
  const message = protocols.length > 0
    ? `"${clause.slice(0, 120)}" does not match a supported "deposit" sentence: it names no venue. ${what}${where} run on ${protocols.map(protocolName).join(", ")}; say which one,${example}`
    : `"${clause.slice(0, 120)}" does not match a supported "deposit" sentence: no lending venue takes ${asset ?? "that asset"}${where}.`;
  return unsupported(message, GRAMMAR_EXAMPLES, [{ path: "text", message: "Name a venue (into <venue>)." }]);
}

/** The amount placeholder of the desk's "Move here" sentences ("Deposit [EDIT AMOUNT] USDC into ..."). */
const AMOUNT_PLACEHOLDER = /\s*\[\s*edit[\s_-]*amount\s*\]/giu;
/** "... into <venue name> on <network name>": a venue said by its full registry name (the data dashboard's sentences). */
const VENUE_NAME_CLAUSE = /^(?<head>.*?\s(?:into|from|out\s+of)\s+)(?:the\s+)?(?<name>.+?)\s+(?:on|in)\s+(?<net>[a-z][a-z0-9 -]*)$/iu;

function nameKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, " ");
}

/**
 * Reads the data dashboard's "Move here" sentence (`Deposit [EDIT AMOUNT] USDC into Kamino JLP USDC on Solana`) in
 * the grammar's own words: the amount placeholder is dropped (the amount is then asked, or refused on the strict
 * path), and a venue said by its full registry name on its network becomes its venue word and, for protocols named
 * by slug, the slug ("into kamino jlp-usdc on solana"). Any other text is returned unchanged.
 */
export function readVenueNames(text: string): string {
  const unplaced = text.replace(AMOUNT_PLACEHOLDER, "");
  const match = VENUE_NAME_CLAUSE.exec(unplaced.trim());
  if (!match?.groups) return unplaced;
  const network = resolveNetworkName(match.groups.net as string);
  const name = nameKey(match.groups.name as string);
  const venue = network ? YIELD_VENUES.find((entry) => entry.network === network && nameKey(entry.name) === name) : undefined;
  if (!venue || !network) return unplaced;
  const slug = VAULT_PROTOCOLS.includes(venue.protocol) ? ` ${venue.slug}` : "";
  return `${match.groups.head}${venueWordOf(venue.protocol)}${slug} on ${network}`;
}

/** The first grammar venue word of a protocol ("aave-v3" -> "aave"). */
function venueWordOf(protocol: ProtocolId): string {
  return GRAMMAR_VENUE_WORDS.find((word) => LENDING_VENUES.find((venue) => venue.pattern.test(word))?.protocol === protocol) ?? protocol;
}
