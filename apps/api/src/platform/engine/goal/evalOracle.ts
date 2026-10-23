/**
 * Independent oracles of the intent eval (design A.4, E.2): checks run on
 * every ready result that do not trust the reader, the accept regexes or the
 * engine's own provenance. They read only the person's text, the resolved
 * actions and the fixture balances, so a regex that is too permissive cannot
 * hide a plan that pays an unsaid recipient, crosses networks without a leg,
 * drops a named venue or ignores a closed-class word.
 *
 * Flags are short codes with a detail ("I2 network: step 2 on base, step 1
 * lands on solana"). A ready result of a passing prompt must raise none, or
 * the flag is allowlisted in the ledger with a reviewed reason; a failing
 * (ledgered) prompt's flags are informative.
 *
 * Invariants checked (A.4 numbering): I2 network continuity, I3 recipient
 * fidelity, I4 verb fidelity, I5 venue fidelity, I6 holding claims, I7 stake
 * input, I8 address family, I9 funding, I10 round trip, I13 third-party value,
 * I14 look-alike exactness, I16 closed-class conservation; plus the
 * conservation of numbers and unit words (E.2).
 */
import {
  CLOSED_CLASS_RULES,
  FOLLOW_UP_VENUE_WORDS,
  LOOKALIKE_FAMILIES,
  UNIT_WORDS,
  isKnownSymbol,
  normalizeMessage,
  scanClosedClass,
  type NetworkKey,
} from "@kletia/core";
import type { ResolvedAction } from "../clarify/types.js";

export interface OracleInput {
  /** The person's message as typed. */
  readonly text: string;
  readonly actions: readonly ResolvedAction[];
  /** The fixture wallet's balances (network -> symbol -> decimal), or null when unknown. */
  readonly balances: Readonly<Record<string, Readonly<Record<string, string>>>> | null;
  /** The ready result came after a one-click confirm the person answered. */
  readonly confirmed?: boolean;
}

const lower = (value: string | undefined) => (value ?? "").toLowerCase();
const upper = (value: string | undefined) => (value ?? "").toUpperCase();
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const wordIn = (text: string, word: string) => new RegExp(`(?<![\\w.])${escape(word).replace(/ /gu, "\\s+")}(?![\\w])`, "iu").test(text);

const landing = (action: ResolvedAction): NetworkKey => action.toNetwork ?? action.network;
const outputSymbol = (action: ResolvedAction) => upper(action.to && action.to !== "" ? action.to : action.from);
/** A native asset and its wrapped form are one asset here. */
const unwrapped = (symbol: string) => ({ WETH: "ETH", WSOL: "SOL", WPOL: "POL" })[symbol] ?? symbol;

/**
 * A step spends the previous step's output (render.ts's rule: a later "max"
 * step), and spends that asset: a "max" of another asset is a whole holding
 * of its own (I6, I13).
 */
function dependent(actions: readonly ResolvedAction[], index: number): boolean {
  const action = actions[index] as ResolvedAction;
  if (action.amount !== "max" || index === 0 || action.kind === "withdraw") return false;
  const previous = actions[index - 1] as ResolvedAction;
  return !action.from || unwrapped(upper(action.from)) === unwrapped(outputSymbol(previous));
}

// -------------------------------------------------------------- recipients

const NAME = /(?<![\w.-])[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.(?:eth|sns|sol)(?![\w.-])/giu;
const EVM_ADDRESS = /(?<![\w])0x[0-9a-fA-F]{40}(?![\w])/gu;
const SOLANA_ADDRESS = /(?<![\w])[1-9A-HJ-NP-Za-km-z]{32,44}(?![\w])/gu;

/** Recipients the text names: names, EVM addresses and Solana addresses (lower-cased). */
export function recipientsSaid(text: string): string[] {
  const out = new Set<string>();
  for (const pattern of [NAME, EVM_ADDRESS, SOLANA_ADDRESS]) for (const match of text.matchAll(pattern)) out.add(match[0].toLowerCase());
  return [...out];
}

// -------------------------------------------------------------- venues

/** Venue and provider words the eval checks, with the protocol or provider ids that honour them. */
const VENUE_CHECK: Readonly<Record<string, readonly string[]>> = (() => {
  const out: Record<string, string[]> = {};
  for (const [word, entry] of Object.entries(FOLLOW_UP_VENUE_WORDS)) {
    // Short words and symbols ("uni", "jup", "aero", "velo") are too ambiguous to check from text alone.
    if (word.length < 4 || isKnownSymbol(word)) continue;
    out[word] = [entry.protocol];
  }
  out.spark = ["spark-savings", "sparklend"];
  out.jupiter = ["jupiter", "jupiter-lend"];
  Object.assign(out, {
    pancakeswap: ["pancakeswap-v3"], pancake: ["pancakeswap-v3"], camelot: ["camelot"], curve: ["curve"],
    jito: ["jito"], marinade: ["marinade"], sanctum: ["jupiter"], lido: ["lido"], "rocket pool": ["rocket-pool"], rocketpool: ["rocket-pool"],
    etherfi: ["etherfi"], "ether.fi": ["etherfi"], stader: ["stader"], frax: ["frax-ether"],
  });
  return out;
})();

/** Words that turn a venue into one to avoid ("without aave", "not via relay"). */
const AVOIDING = /\b(?:without|not|avoid|avoiding|except|no)\s+(?:using\s+|via\s+|through\s+|on\s+)?(?:the\s+)?$/iu;

// -------------------------------------------------------------- verbs

const SWAP_VERBS = /\b(?:swap|swp|trade|convert|exchange|sell|dump|hedge|diversify|wrap|unwrap|cash out)\b/iu;
const DEPOSIT_WORDS = /\b(?:deposit|depost|supply|lend|invest|earn|yield|work|park|put|place|max out|apy|rate|aave|morpho|compound|moonwell|kamino|spark|sparklend|fluid|yearn|jupiter lend|jup lend|venue|zap|lending)\b/iu;
const STAKE_WORDS = /\b(?:stake|stkae|staking|restake|jito|marinade|sanctum|lido|rocket ?pool|etherfi|ether\.fi|stader|mantle|frax|jupsol|jitosol|msol|wsteth|reth|weeth|eth staking|solana staking)\b/iu;

// -------------------------------------------------------------- symbols

/** Scope words under which a plan moves assets the person did not name one by one. */
const SCOPE_WORDS = /\b(?:everything|consolidate|sweep|dust|cash out|go all in|move it all|all my (?:stables|stablecoins|money|funds|tokens|assets|balances)|tiny balances|close everything|exit all|rebalance|even out)\b/iu;

/** Words that stand for a USD stablecoin ("$50", "50 bucks", "stables"). */
const USD_WORDS = /(?:\$|\b(?:usd|dollars?|bucks|stables?|stablecoins?|cash out|cash|sell|hedge|de-risk)\b)/iu;
/** Asset aliases a person may type for a listed symbol. */
const SYMBOL_ALIASES: Readonly<Record<string, readonly string[]>> = {
  ETH: ["eth", "ether", "gas", "weth"],
  WETH: ["weth", "eth"],
  POL: ["pol", "matic", "gas"],
  WPOL: ["wpol", "pol", "matic"],
  SOL: ["sol", "solana", "gas", "wsol"],
  CBBTC: ["cbbtc", "btc", "bitcoin", "sats"],
  USDC: ["usdc", "usd"],
};

/** A symbol as a whole word, also glued to a number ("1SOL") or a cashtag ("$SOL"). */
const symbolIn = (text: string, word: string) => new RegExp(`(?<![a-z.])\\$?${escape(word)}(?![\\w])`, "iu").test(text);

function typedSymbol(text: string, symbol: string): boolean {
  const key = upper(symbol);
  if (symbolIn(text, symbol)) return true;
  for (const alias of SYMBOL_ALIASES[key] ?? []) if (symbolIn(text, alias)) return true;
  if (["USDC", "USDT", "USDT0", "DAI", "PYUSD", "USDS"].includes(key) && USD_WORDS.test(text)) return true;
  return false;
}

/** Unlisted look-alike spellings the text holds, by family id ("steth" -> eth). */
function lookalikesTyped(text: string): { typed: string; family: string; members: string[] }[] {
  const out: { typed: string; family: string; members: string[] }[] = [];
  for (const family of LOOKALIKE_FAMILIES) {
    for (const member of family.members) {
      if (isKnownSymbol(member)) continue;
      const spellings = [member, member.replace(/[.\s-]/gu, "")];
      if (spellings.some((spelling) => wordIn(text, spelling))) out.push({ typed: member, family: family.id, members: family.members.map(upper) });
    }
  }
  return out;
}

// -------------------------------------------------------------- numbers

const NUMBER = /(?<![\w.$/-])(\$)?(\d+(?:[.,]\d+)*(?:e[+-]?\d+)?)(?![\w/]|[.,]\d)/gu;

function numberValues(raw: string): number[] {
  const values = new Set<number>();
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/u.test(raw)) values.add(Number(raw.replace(/,/gu, "")));
  if (/^\d{1,3}(?:\.\d{3})+(?:,\d+)?$/u.test(raw)) values.add(Number(raw.replace(/\./gu, "").replace(",", ".")));
  if (/^\d+,\d+$/u.test(raw)) values.add(Number(raw.replace(",", ".")));
  if (/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/u.test(raw)) values.add(Number(raw));
  return [...values].filter(Number.isFinite);
}

const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-12, Math.abs(a) * 1e-9);

// -------------------------------------------------------------- the oracle

/** Every invariant and conservation flag of one ready result (empty: none). */
export function oracleFlags(input: OracleInput): string[] {
  const flags: string[] = [];
  const text = input.text;
  const normal = normalizeMessage(text).toLowerCase();
  const actions = input.actions;

  // I2 network continuity: a step that spends the previous output runs where it lands.
  actions.forEach((action, index) => {
    if (!dependent(actions, index)) return;
    const previous = actions[index - 1] as ResolvedAction;
    if (action.network !== landing(previous)) flags.push(`I2 network: step ${index + 1} runs on ${action.network}, step ${index} lands on ${landing(previous)}`);
  });

  // I3 recipient fidelity: only said recipients are paid, and every said recipient is paid.
  const said = recipientsSaid(text);
  const paid = [...new Set(actions.map((action) => lower(action.recipient)).filter(Boolean))];
  for (const recipient of paid) if (!said.includes(recipient)) flags.push(`I3 recipient: ${recipient} is paid but not said`);
  for (const recipient of said) if (!paid.includes(recipient)) flags.push(`I3 recipient: ${recipient} is said but not paid`);

  // I4 verb fidelity: no swap becomes a deposit, a stake or nothing.
  const kinds = new Set(actions.map((action) => action.kind));
  if (kinds.has("deposit") && !DEPOSIT_WORDS.test(normal)) flags.push("I4 verb: a deposit nobody asked for");
  if (kinds.has("stake") && !STAKE_WORDS.test(normal)) flags.push("I4 verb: a stake nobody asked for");
  const converts = actions.some((action) => action.kind === "swap" || (action.kind === "bridge" && action.to !== undefined && action.to !== "" && upper(action.to) !== upper(action.from)));
  if (SWAP_VERBS.test(normal) && !converts && !kinds.has("stake") && !/\b(?:wrap|unwrap)\b/iu.test(normal)) flags.push("I4 verb: a conversion was asked, none is planned");

  // I5 venue fidelity: a named venue is on a step; an avoided one is not.
  const used = new Set(actions.flatMap((action) => [lower(action.protocol), lower(action.provider)]).filter(Boolean));
  for (const [word, protocols] of Object.entries(VENUE_CHECK)) {
    const match = new RegExp(`(?<![\\w.])${escape(word).replace(/ /gu, "\\s+")}(?![\\w])`, "iu").exec(normal);
    if (!match) continue;
    // "jupiter lend" names the lending venue, not the DEX; "spark" covers both Spark venues.
    if (word === "jupiter" && /\bjupiter\s+(?:lend|earn)\b/iu.test(normal)) continue;
    const avoided = AVOIDING.test(normal.slice(0, match.index));
    const present = protocols.some((protocol) => used.has(protocol));
    if (avoided && present) flags.push(`I5 venue: ${word} is avoided but used`);
    if (!avoided && !present) flags.push(`I5 venue: ${word} is named but not used`);
  }

  // ... and a move to "the best" venue never lands back in the venue it left.
  actions.forEach((action, index) => {
    const previous = index > 0 ? actions[index - 1] : undefined;
    if (action.kind === "deposit" && dependent(actions, index) && previous?.kind === "withdraw" && previous.protocol === action.protocol && previous.network === action.network) {
      flags.push(`I5 venue: deposits back into ${action.protocol ?? "?"}, the venue it withdrew from`);
    }
  });

  // I6 holding claims: two steps spending all of one holding.
  const maxClaims = new Map<string, number>();
  actions.forEach((action, index) => {
    if (dependent(actions, index) || action.amount !== "max" || action.kind === "withdraw") return;
    const key = `${action.network}:${upper(action.from)}`;
    maxClaims.set(key, (maxClaims.get(key) ?? 0) + 1);
  });
  for (const [key, count] of maxClaims) if (count > 1) flags.push(`I6 holding: ${count} steps spend all of ${key}`);

  // I7 stake input: a stake spends its provider's input asset.
  for (const action of actions) {
    if (action.kind === "stake" && !["SOL", "ETH"].includes(upper(action.from))) flags.push(`I7 stake input: stakes ${action.from}`);
  }

  // I8 address family: a recipient is used only on networks of its family.
  for (const action of actions) {
    const recipient = lower(action.recipient);
    if (!recipient) continue;
    const svm = action.network === "solana" || action.network === "solana-devnet";
    const destinationSvm = landing(action) === "solana" || landing(action) === "solana-devnet";
    const evmRecipient = /^0x[0-9a-f]{40}$/u.test(recipient) || /\.eth$/u.test(recipient);
    const svmRecipient = /\.(?:sns|sol)$/u.test(recipient) || /^[1-9a-hj-np-z]{32,44}$/u.test(recipient);
    const svmLanding = action.kind === "bridge" ? destinationSvm : svm;
    if ((evmRecipient && svmLanding) || (svmRecipient && !svmLanding)) flags.push(`I8 family: ${recipient} paid on ${landing(action)}`);
  }

  // I9 funding: an exact spend never exceeds the known balance of its holding.
  if (input.balances) {
    actions.forEach((action, index) => {
      if (dependent(actions, index) || action.amount === "max" || action.amount === "" || action.kind === "withdraw") return;
      const row = input.balances?.[action.network];
      if (!row) return;
      const key = Object.keys(row).find((entry) => upper(entry) === upper(action.from));
      const balance = key ? Number(row[key]) : 0;
      if (Number(action.amount) > balance + 1e-12) flags.push(`I9 funding: spends ${action.amount} ${action.from} on ${action.network}, holds ${balance}`);
    });
  }

  // I10 round trip: the same funds never leave a network and come back.
  {
    let path: NetworkKey[] = [];
    actions.forEach((action, index) => {
      if (!dependent(actions, index)) path = [action.network];
      const to = landing(action);
      if (to !== path[path.length - 1]) {
        if (path.includes(to)) flags.push(`I10 round trip: funds return to ${to} at step ${index + 1}`);
        path.push(to);
      }
    });
  }

  // I13 third-party value: a whole or partial holding paid to someone else, or no receiving network, needs an answer or a confirm.
  const NETWORK = "(?:base|arbitrum(?:\\s+one)?|arb|ethereum|eth\\s+mainnet|mainnet|optimism|op(?:\\s+mainnet)?|polygon(?:\\s+pos)?|matic|solana|sol|arc|devnet|arbitrum\\s+sepolia)";
  const networkSaid = new RegExp(
    `\\b(?:on|from|to|onto|into|over|via)\\s+(?:the\\s+)?${NETWORK}\\b|\\b${NETWORK}\\s*$|\\b(?:base|arbitrum|optimism|polygon|solana|ethereum)\\s+(?:usdc|usdt|eth|sol|pol|funds|wallet)\\b`,
    "iu",
  );
  actions.forEach((action, index) => {
    if (!action.recipient || input.confirmed) return;
    const recipient = lower(action.recipient);
    const ownLeg = dependent(actions, index);
    if (!ownLeg && action.amount === "max") flags.push(`I13 third party: pays all of a holding to ${recipient}`);
    const impliesNetwork = /\.(?:base\.eth|sns|sol)$/u.test(recipient) || /^[1-9a-hj-np-z]{32,44}$/u.test(recipient);
    if (!ownLeg && !impliesNetwork && !networkSaid.test(normal)) flags.push(`I13 third party: receiving network of ${recipient} not said`);
  });

  // I14 look-alike exactness: a typed look-alike is never read as another member of its family.
  for (const typed of lookalikesTyped(normal)) {
    for (const action of actions) {
      for (const symbol of [upper(action.from), outputSymbol(action)]) {
        if (typed.members.includes(symbol) && symbol !== upper(typed.typed).replace(/[.\s-]/gu, "")) {
          if (!input.confirmed) flags.push(`I14 look-alike: "${typed.typed}" read as ${symbol}`);
        }
      }
    }
  }
  // ... and every spent or received symbol is one the person typed (or one a rule derives).
  if (!SCOPE_WORDS.test(normal)) actions.forEach((action, index) => {
    const checks: string[] = [];
    if (!dependent(actions, index) && action.from) checks.push(upper(action.from));
    if (action.to && action.kind === "swap") checks.push(upper(action.to));
    for (const symbol of checks) {
      if (typedSymbol(normal, symbol)) continue;
      // A stake's LST, a deposit's or a withdrawal's underlying, a sell into a stablecoin are derived by fixed rules.
      if (action.kind === "stake" || action.kind === "withdraw" || action.kind === "deposit") continue;
      if (!input.confirmed) flags.push(`I14 symbol: ${symbol} was not typed`);
    }
  });

  // I16 closed-class conservation: every never-drop, unit and network word is consumed by a rule that plans.
  const amounts = actions.flatMap((action) => (action.amount && action.amount !== "max" ? [Number(action.amount)] : []));
  for (const hit of scanClosedClass(normal)) {
    if (hit.category === "network") {
      flags.push(`I16 closed class: unsupported network "${hit.phrase}" in a ready plan`);
      continue;
    }
    if (hit.category === "unit") {
      // A unit on a USD amount ("$1.5k of sol") is converted into the asset: nothing to compare.
      if (/\$\s*\d[\d.,]*\s*$/u.test(normal.slice(0, hit.start)) || /^\s*(?:\$|usd\b|dollars?\b|bucks\b)/u.test(normal.slice(hit.end))) continue;
      const unit = UNIT_WORDS[hit.phrase];
      const number = /(\d+(?:[.,]\d+)?)\s*$/u.exec(normal.slice(0, hit.start))?.[1];
      const value = number && unit ? Number(number.replace(",", ".")) * Number(unit.factor) : Number.NaN;
      if (!amounts.some((amount) => close(amount, value))) flags.push(`I16 closed class: unit "${hit.phrase}" not applied`);
      continue;
    }
    const consumed = hit.rules.some((id) => {
      const rule = CLOSED_CLASS_RULES[id];
      if (!rule || !rule.context || (rule.outcome !== "plan" && !(rule.outcome === "confirm" && input.confirmed))) return false;
      const pattern = new RegExp(rule.context.source, "giu");
      for (const match of normal.matchAll(pattern)) {
        const start = match.index ?? 0;
        if (start <= hit.start && start + match[0].length >= hit.end) return true;
      }
      return false;
    });
    if (!consumed) flags.push(`I16 closed class: "${hit.phrase}" (${hit.category}) not consumed by a rule`);
  }

  // Conservation of numbers (E.2): every number the person wrote is used, converted or consumed.
  const planned = actions.flatMap((action) => (action.amount && action.amount !== "max" ? [Number(action.amount)] : []));
  // Spelled numbers come out as "20 5" ("twenty five"): a ten and a unit are one number.
  const composed = normal.replace(/\b([2-9]0) ([1-9])\b/gu, (_, tens: string, unit: string) => String(Number(tens) + Number(unit)));
  const wanted = new Set(actions.filter((action) => (action.kind === "swap" || action.kind === "bridge") && action.to).map((action) => lower(action.to)));
  for (const match of composed.matchAll(NUMBER)) {
    const raw = match[2] as string;
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const after = composed.slice(end, end + 12);
    const before = composed.slice(Math.max(0, start - 14), start);
    // A wanted amount ("buy 0.01 eth with usdc") is back-solved into the spend.
    const unitWord = /^\s*([a-z][\w.]*)/u.exec(after)?.[1];
    if (unitWord && wanted.has(unitWord)) continue;
    if (match[1] === "$" || /^\s*(?:\$|usd\b|dollars?\b|bucks\b|%|percent\b|pct\b|bps\b)/u.test(after) || /\busd\s*$/u.test(before)) continue;
    if (/(?:\bbut|except|keep|leave)\s+(?:\w+\s+)?$/u.test(before)) continue;
    if (/^\s*(?:[a-z]+\s+)?(?:of\s+(?:it|them|that|those|the))\b/u.test(after) && planned.some((value) => numberValues(raw).some((n) => close(value, n)))) continue;
    if (Object.keys(UNIT_WORDS).some((unit) => new RegExp(`^\\s?${escape(unit)}\\b`, "u").test(after))) continue;
    if (/^\s*x\b/u.test(after)) continue;
    if (!planned.some((value) => numberValues(raw).some((n) => close(value, n)))) flags.push(`N number: ${raw} is not an amount of the plan`);
    // "1.000" is one thousand in the owner's locale: a dot-thousands amount is asked, never read silently (WP7).
    if (/^[1-9]\d{0,2}\.\d{3}$/u.test(raw) && !input.confirmed) flags.push(`N number: ${raw} has two readings (dot-thousands) and was not asked`);
  }
  return flags;
}
