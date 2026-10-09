/**
 * Deterministic natural-language intent grammar. Text is split into clauses
 * and each clause must match exactly one known sentence shape; anything else
 * is refused with INTENT_UNSUPPORTED and example phrases. No model is
 * involved and nothing is guessed: when a network cannot be inferred from
 * the text, the previous clause, `defaultNetwork` or the caller's accounts,
 * the clause is refused.
 */
import {
  CHAINS,
  findAssetBySymbol,
  isEvmAddress,
  isSolanaAddress,
  MAX_INTENT_ACTIONS,
  parseAccountId,
  resolveChain,
  YIELD_VENUES,
  type AccountId,
  type IntentActionKind,
  type IntentActionSpec,
  type NetworkKey,
  type ProtocolId,
} from "@kletia/core";
import { PlatformError, unsupported } from "../errors.js";

export const GRAMMAR_EXAMPLES: readonly string[] = Object.freeze([
  "swap 1 SOL to USDC",
  "swap 0.01 ETH for USDC on base",
  "buy JitoSOL with 2 SOL",
  "stake 1.5 SOL with marinade",
  "send 5 USDC to 9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
  "send 0.001 ETH to 0x000000000000000000000000000000000000dEaD on arbitrum",
  "bridge 25 USDC from base to solana",
  "bridge 100 USDC from solana to arbitrum",
  "move 0.01 ETH from arbitrum to solana as SOL",
  "bridge 50 USDC from base to solana then swap half to JitoSOL",
  "bridge 20 USDC from solana to base and deposit it into aave",
  "swap 10 USDC to SOL on solana, then stake it with jito",
  "deposit 100 USDC into morpho on base",
  "withdraw 50 USDC from aave on base",
  "withdraw all USDC from compound on arbitrum",
  "deposit 10 USDC into jupiter lend",
  "bridge 25 USDC from base to solana via lifi",
  "bridge 100 USDC from ethereum to base",
  "send 5 USDC to vitalik.eth on optimism",
]);

/** Lending venue words -> protocol. */
const LENDING_VENUES: readonly { readonly pattern: RegExp; readonly protocol: ProtocolId }[] = [
  { pattern: /^aave(?:[\s-]*v3)?$/iu, protocol: "aave-v3" },
  { pattern: /^(?:compound(?:[\s-]*v3)?|comet)$/iu, protocol: "compound-v3" },
  { pattern: /^morpho(?:[\s-]+vaults?)?$/iu, protocol: "morpho" },
  { pattern: /^moonwell$/iu, protocol: "moonwell" },
  { pattern: /^(?:jupiter|jup)[\s-]+(?:lend|earn)$/iu, protocol: "jupiter-lend" },
  { pattern: /^kamino(?:[\s-]+lend)?$/iu, protocol: "kamino" },
];
const LENDING_WORDS =
  "aave(?:[\\s-]*v3)?|compound(?:[\\s-]*v3)?|comet|morpho(?:[\\s-]+vaults?)?|moonwell|(?:jupiter|jup)[\\s-]+(?:lend|earn)|kamino(?:[\\s-]+lend)?";

/** Cross-network venue words -> protocol ("bridge ... via lifi"). */
const BRIDGE_VENUES: readonly { readonly pattern: RegExp; readonly protocol: ProtocolId }[] = [
  { pattern: /^(?:li\.?fi)$/iu, protocol: "lifi" },
  { pattern: /^(?:debridge(?:[\s-]+dln)?|dln)$/iu, protocol: "debridge-dln" },
  { pattern: /^relay$/iu, protocol: "relay" },
];
const BRIDGE_WORDS = "li\\.?fi|debridge(?:[\\s-]+dln)?|dln|relay";

/** Liquid staking targets reachable through Jupiter routes. */
export const LIQUID_STAKING_TOKENS: Readonly<Record<string, { symbol: string; provider: string }>> = Object.freeze({
  jito: { symbol: "JitoSOL", provider: "Jito" },
  jitosol: { symbol: "JitoSOL", provider: "Jito" },
  marinade: { symbol: "mSOL", provider: "Marinade" },
  msol: { symbol: "mSOL", provider: "Marinade" },
  jupiter: { symbol: "JupSOL", provider: "Jupiter" },
  jupsol: { symbol: "JupSOL", provider: "Jupiter" },
  sanctum: { symbol: "JupSOL", provider: "Jupiter" },
});

export interface GrammarContext {
  readonly defaultNetwork?: NetworkKey;
  readonly accounts?: readonly AccountId[];
}

export interface GrammarResult {
  readonly actions: IntentActionSpec[];
  readonly normalizedText: string;
  readonly clauses: readonly string[];
  readonly confidence: number;
}

type AmountPhrase =
  | { readonly type: "exact"; readonly value: string; readonly usd: boolean }
  /** `whole`: said as "all" / "max" / "everything" (a withdraw then closes the position). */
  | { readonly type: "previous"; readonly portionBps: number; readonly whole?: boolean };

interface Draft {
  readonly clause: string;
  readonly kind: IntentActionKind;
  readonly amount: AmountPhrase;
  readonly from?: string;
  readonly to?: string;
  readonly network?: NetworkKey;
  readonly toNetwork?: NetworkKey;
  readonly recipient?: string;
  readonly lst?: string;
  readonly protocol?: ProtocolId;
  /** Morpho vault slug named in the clause. */
  readonly venue?: string;
}

const VERBS = [
  "swap", "convert", "trade", "exchange", "sell", "buy", "bridge", "move", "send", "transfer", "pay", "port",
  "stake", "deposit", "supply", "lend", "withdraw", "redeem",
];
const VERB_ALT = VERBS.join("|");

const AMOUNT =
  "(?<amt>\\d{1,3}(?:\\.\\d{1,2})?%|\\$\\d[\\d,]*(?:\\.\\d+)?|\\d[\\d,]*(?:\\.\\d+)?|\\.\\d+|all|max|everything|it|them|that|half|a\\s+quarter|quarter)" +
  "(?:\\s+of\\s+(?:it|them|that|the\\s+output|the\\s+proceeds))?";
const KEYWORD_GUARD = "(?!(?:to|for|into|onto|with|using|from|on|as|via|in|at)\\b)";
const ASSET = (name: string) => `${KEYWORD_GUARD}(?<${name}>(?:eip155|solana):\\S+|[A-Za-z0-9$][\\w.\\-]{0,63})`;
const NETWORK_WORDS =
  "arbitrum[\\s-]+sepolia|arb[\\s-]+sepolia|solana[\\s-]+devnet|solana[\\s-]+mainnet|arbitrum[\\s-]+one|arc[\\s-]+testnet|base[\\s-]+mainnet|" +
  "ethereum[\\s-]+mainnet|op[\\s-]+mainnet|optimism[\\s-]+mainnet|polygon[\\s-]+pos|polygon[\\s-]+mainnet|mainnet-beta|" +
  "base|arbitrum|arb|arc|solana|sol|devnet|ethereum|optimism|polygon|matic|op";
const NETWORK = (name: string) => `(?<${name}>${NETWORK_WORDS})`;
const ON_NETWORK = `(?:\\s+(?:on|in|via)\\s+${NETWORK("net")})`;
/** Recipient names resolved through the name hook (ENS, Basenames, SNS). */
const NAME = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\\.(?:eth|sns|sol)";
const ADDRESS = `(?<addr>0x[0-9a-fA-F]{40}|(?:eip155|solana):\\S+|${NAME}|[1-9A-HJ-NP-Za-km-z]{32,44})`;
/** A Morpho vault slug after the venue word ("into morpho spark-usdc"); never a connector or "vault" itself. */
const VAULT = "(?!(?:to|for|into|onto|with|using|from|on|as|via|in|at|vault|vaults|position)\\b)(?<vault>[a-z0-9][a-z0-9-]{2,63})";
const LST_WORDS = Object.keys(LIQUID_STAKING_TOKENS).join("|");

const PATTERNS: readonly { kind: IntentActionKind | "buy" | "bridge-or-transfer"; regex: RegExp }[] = [
  {
    kind: "swap",
    regex: new RegExp(
      `^(?:swap|convert|trade|exchange|sell)\\s+${AMOUNT}(?:\\s+${ASSET("a")})?\\s+(?:to|for|into)\\s+${ASSET("b")}${ON_NETWORK}?$`,
      "iu",
    ),
  },
  {
    kind: "buy",
    regex: new RegExp(`^buy\\s+${ASSET("b")}\\s+(?:with|using)\\s+${AMOUNT}(?:\\s+${ASSET("a")})?${ON_NETWORK}?$`, "iu"),
  },
  {
    kind: "bridge",
    regex: new RegExp(
      `^(?:bridge|move|send|transfer|port)\\s+${AMOUNT}(?:\\s+${ASSET("a")})?(?:\\s+from\\s+${NETWORK("n1")})?\\s+(?:to|into|onto)\\s+${NETWORK("n2")}(?:\\s+(?:as|into|for)\\s+${ASSET("b")})?` +
        `(?:\\s+(?:via|using|through|with|over)\\s+(?<bridge>${BRIDGE_WORDS}))?$`,
      "iu",
    ),
  },
  {
    kind: "transfer",
    regex: new RegExp(`^(?:send|transfer|pay)\\s+${AMOUNT}(?:\\s+${ASSET("a")})?\\s+to\\s+${ADDRESS}${ON_NETWORK}?$`, "iu"),
  },
  {
    kind: "stake",
    regex: new RegExp(
      `^stake\\s+${AMOUNT}(?:\\s+(?<a>sol))?(?:\\s+(?:with|via|on|using|into|to|as|at)\\s+(?<lst>${LST_WORDS}))?${ON_NETWORK}?$`,
      "iu",
    ),
  },
  {
    kind: "deposit",
    regex: new RegExp(
      `^(?:deposit|supply|lend)\\s+${AMOUNT}(?:\\s+${ASSET("a")})?\\s+(?:into|to|on|in|at|with)\\s+(?:the\\s+)?(?<venue>${LENDING_WORDS})` +
        `(?:\\s+${VAULT})?(?:\\s+vault)?${ON_NETWORK}?$`,
      "iu",
    ),
  },
  {
    kind: "withdraw",
    regex: new RegExp(
      `^(?:withdraw|redeem)\\s+${AMOUNT}(?:\\s+(?:of\\s+)?(?:my\\s+)?${ASSET("a")})?\\s+(?:from|out\\s+of)\\s+(?:my\\s+)?(?:the\\s+)?(?<venue>${LENDING_WORDS})` +
        `(?:\\s+${VAULT})?(?:\\s+(?:vault|position))?${ON_NETWORK}?$`,
      "iu",
    ),
  },
];

function normalizeText(text: string): string {
  let value = text
    .replace(/[→➡]|->|=>/gu, " to ")
    .replace(/[“”"']/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[.!?]+$/u, "")
    .trim();
  const prefix = /^(?:please|pls|kletia,?|i want to|i'?d like to|i would like to|can you|could you|let's|lets)\s+/iu;
  while (prefix.test(value)) value = value.replace(prefix, "");
  return value;
}

export function splitClauses(text: string): string[] {
  const verbLookahead = `(?=(?:${VERB_ALT})\\b)`;
  return text
    .split(/\s*;\s*|\s*,?\s+and\s+then\s+|\s*,\s*then\s+|\s+then\s+/iu)
    .flatMap((part) => part.split(new RegExp(`\\s*,?\\s+and\\s+${verbLookahead}|\\s*,\\s*${verbLookahead}`, "iu")))
    .map((part) => part.trim().replace(/^(?:and|also)\s+/iu, "").replace(/[,.]+$/u, "").trim())
    .filter((part) => part.length > 0);
}

export function resolveNetworkName(raw: string): NetworkKey | null {
  const value = raw.trim().toLowerCase().replace(/\s+/gu, " ");
  return resolveChain(value)?.key ?? resolveChain(value.replace(/ /gu, "-"))?.key ?? null;
}

function parseAmount(raw: string, clause: string): AmountPhrase {
  const value = raw.trim().toLowerCase().replace(/\s+/gu, " ");
  const percent = /^(\d{1,3}(?:\.\d{1,2})?)%$/u.exec(value);
  if (percent) {
    const bps = Math.round(Number(percent[1]) * 100);
    if (bps <= 0 || bps > 10_000) throw clauseError(clause, "A percentage must be between 0 and 100.");
    return { type: "previous", portionBps: bps };
  }
  if (value === "half") return { type: "previous", portionBps: 5_000 };
  if (value === "quarter" || value === "a quarter") return { type: "previous", portionBps: 2_500 };
  if (["all", "max", "everything"].includes(value)) return { type: "previous", portionBps: 10_000, whole: true };
  if (["it", "them", "that"].includes(value)) return { type: "previous", portionBps: 10_000 };
  const usd = value.startsWith("$");
  let numeric = value.replace(/^\$/u, "");
  if (numeric.includes(",")) {
    // Commas are accepted only as thousands separators ("1,250.5"). "1,5" (a decimal comma) is refused, never read as 15.
    if (!/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/u.test(numeric)) {
      throw clauseError(clause, `"${raw}" is ambiguous; use a dot for decimals (e.g. "1.5").`);
    }
    numeric = numeric.replace(/,/gu, "");
  }
  if (numeric.startsWith(".")) numeric = `0${numeric}`;
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(numeric) || /^0(?:\.0+)?$/u.test(numeric)) {
    throw clauseError(clause, `"${raw}" is not a positive amount.`);
  }
  return { type: "exact", value: numeric, usd };
}

function clauseError(clause: string, message: string): PlatformError {
  return unsupported(`${message} (in "${clause.slice(0, 120)}")`, GRAMMAR_EXAMPLES, [{ path: "text", message }]);
}

function networkFromGroup(raw: string | undefined, clause: string): NetworkKey | undefined {
  if (!raw) return undefined;
  const network = resolveNetworkName(raw);
  if (!network) throw clauseError(clause, `Unknown network "${raw}".`);
  return network;
}

function venueProtocol(raw: string | undefined, venues: typeof LENDING_VENUES, clause: string): ProtocolId {
  const value = (raw ?? "").trim();
  const entry = venues.find((candidate) => candidate.pattern.test(value));
  if (!entry) throw clauseError(clause, `Unknown venue "${value.slice(0, 32)}".`);
  return entry.protocol;
}

function lendingDraft(clause: string, kind: "deposit" | "withdraw", groups: Record<string, string | undefined>, amount: AmountPhrase, network: NetworkKey | undefined): Draft {
  const protocol = venueProtocol(groups.venue, LENDING_VENUES, clause);
  const vault = groups.vault?.toLowerCase();
  if (vault && protocol !== "morpho") throw clauseError(clause, `Only Morpho vaults are named; say "${kind === "deposit" ? "into" : "from"} ${groups.venue ?? "the venue"}" without "${vault}".`);
  return {
    clause,
    kind,
    amount,
    ...(groups.a ? { from: groups.a } : {}),
    protocol,
    ...(vault ? { venue: vault } : {}),
    ...(network ? { network } : {}),
  };
}

function matchClause(clause: string): Draft {
  for (const pattern of PATTERNS) {
    const match = pattern.regex.exec(clause);
    if (!match?.groups) continue;
    const groups = match.groups;
    const amount = parseAmount(groups.amt ?? "", clause);
    const network = networkFromGroup(groups.net, clause);
    switch (pattern.kind) {
      case "swap":
      case "buy":
        return {
          clause,
          kind: "swap",
          amount,
          ...(groups.a ? { from: groups.a } : {}),
          ...(groups.b ? { to: groups.b } : {}),
          ...(network ? { network } : {}),
        };
      case "bridge": {
        const source = networkFromGroup(groups.n1, clause);
        const destination = networkFromGroup(groups.n2, clause);
        return {
          clause,
          kind: "bridge",
          amount,
          ...(groups.a ? { from: groups.a } : {}),
          ...(groups.b ? { to: groups.b } : {}),
          ...(source ? { network: source } : {}),
          ...(destination ? { toNetwork: destination } : {}),
          ...(groups.bridge ? { protocol: venueProtocol(groups.bridge, BRIDGE_VENUES, clause) } : {}),
        };
      }
      case "transfer":
        return {
          clause,
          kind: "transfer",
          amount,
          ...(groups.a ? { from: groups.a } : {}),
          ...(groups.addr ? { recipient: groups.addr } : {}),
          ...(network ? { network } : {}),
        };
      case "stake":
        return {
          clause,
          kind: "stake",
          amount,
          ...(groups.a ? { from: "SOL" } : {}),
          lst: (groups.lst ?? "jito").toLowerCase(),
          ...(network ? { network } : {}),
        };
      case "deposit":
      case "withdraw":
        return lendingDraft(clause, pattern.kind, groups, amount, network);
      default:
        break;
    }
  }
  const verb = clause.split(/\s+/u)[0]?.toLowerCase() ?? "";
  const reason = VERBS.includes(verb)
    ? `"${clause.slice(0, 120)}" does not match a supported "${verb}" sentence.`
    : `"${verb.slice(0, 32)}" is not a supported action.`;
  throw unsupported(
    `${reason} Supported actions: swap, buy, bridge/move, send/transfer/pay, stake (SOL), deposit/supply/lend into and withdraw from Aave, Compound, Morpho, Moonwell, Jupiter Lend or Kamino.`,
    GRAMMAR_EXAMPLES,
    [{ path: "text", message: `Could not interpret "${clause.slice(0, 120)}".` }],
  );
}

interface InferenceContext {
  readonly defaultNetwork?: NetworkKey;
  readonly accountNetworks: readonly NetworkKey[];
}

const SWAP_NETWORKS: readonly NetworkKey[] = ["solana", "base", "arbitrum"];
const EVM_DEFAULT_NETWORKS: readonly NetworkKey[] = ["base", "arbitrum"];
/** EVM networks a transfer to an address or name may run on, in default order. */
const EVM_TRANSFER_NETWORKS: readonly NetworkKey[] = ["base", "arbitrum", "ethereum", "optimism", "polygon", "arc", "arbitrum-sepolia"];

/** Networks with an executable venue of `protocol` for `kind`, in registry order. */
function lendingNetworks(protocol: ProtocolId | undefined, kind: IntentActionKind): NetworkKey[] {
  return [...new Set(YIELD_VENUES
    .filter((venue) => (!protocol || venue.protocol === protocol) && (venue.actions as readonly string[]).includes(kind))
    .map((venue) => venue.network))];
}

function knownOn(network: NetworkKey, token: string): boolean {
  const chain = CHAINS[network];
  if (token.includes(":")) return token.startsWith(`${chain.id}/`);
  if (isEvmAddress(token)) return chain.namespace === "eip155";
  if (isSolanaAddress(token)) return chain.namespace === "solana";
  if (token.toUpperCase() === chain.nativeAsset.symbol.toUpperCase()) return true;
  return findAssetBySymbol(network, token) !== null;
}

function preferred(candidates: readonly NetworkKey[], context: InferenceContext): NetworkKey | null {
  const order = [context.defaultNetwork, ...context.accountNetworks].filter((entry): entry is NetworkKey => entry !== undefined);
  for (const network of order) if (candidates.includes(network)) return network;
  return null;
}

function inferSwapNetwork(draft: Draft, context: InferenceContext): NetworkKey {
  const tokens = [draft.from ?? (draft.amount.type === "exact" && draft.amount.usd ? "USDC" : undefined), draft.to]
    .filter((token): token is string => token !== undefined);
  const candidates = SWAP_NETWORKS.filter((network) => tokens.every((token) => knownOn(network, token)));
  if (candidates.length === 1) return candidates[0] as NetworkKey;
  if (candidates.length > 1) {
    const pick = preferred(candidates, context);
    if (pick) return pick;
    if (candidates.every((network) => EVM_DEFAULT_NETWORKS.includes(network))) return "base";
    throw clauseError(draft.clause, `Say which network to use, e.g. "${draft.clause} on ${candidates[0]}".`);
  }
  // A token unknown to every EVM registry but plausible on Solana is resolved through Jupiter.
  const evmKnown = tokens.some((token) => EVM_DEFAULT_NETWORKS.some((network) => knownOn(network, token)) && !knownOn("solana", token));
  if (!evmKnown && tokens.every((token) => !isEvmAddress(token))) return "solana";
  throw clauseError(draft.clause, `Cannot find one network that lists ${tokens.join(" and ")}. Add "on <network>".`);
}

function inferTransferNetwork(draft: Draft, context: InferenceContext): NetworkKey {
  const recipient = draft.recipient ?? "";
  if (recipient.includes(":")) {
    const parsed = parseAccountId(recipient);
    if (!parsed) throw clauseError(draft.clause, "The recipient is not a valid CAIP-10 account.");
    return parsed.chain.key;
  }
  // Basenames live on Base; other ENS names follow the caller's EVM network.
  if (/\.base\.eth$/iu.test(recipient)) return "base";
  if (isEvmAddress(recipient) || /\.eth$/iu.test(recipient)) {
    const pick = preferred(EVM_TRANSFER_NETWORKS, context);
    return pick ?? "base";
  }
  if (isSolanaAddress(recipient) || /\.(?:sns|sol)$/iu.test(recipient)) {
    if (context.defaultNetwork === "solana" || context.defaultNetwork === "solana-devnet") return context.defaultNetwork;
    const solanaAccounts = context.accountNetworks.filter((network) => CHAINS[network].namespace === "solana");
    if (solanaAccounts.length > 0 && solanaAccounts.every((network) => network === "solana-devnet")) return "solana-devnet";
    return "solana";
  }
  throw clauseError(draft.clause, "The recipient is not a valid EVM or Solana address.");
}

function inferNetwork(draft: Draft, previousDestination: NetworkKey | undefined, context: InferenceContext): NetworkKey {
  if (draft.network) return draft.network;
  switch (draft.kind) {
    case "transfer": {
      const byAddress = inferTransferNetwork(draft, context);
      if (previousDestination && CHAINS[previousDestination].namespace === CHAINS[byAddress].namespace && !draft.recipient?.includes(":")) {
        return previousDestination;
      }
      return byAddress;
    }
    case "stake":
      return previousDestination ?? "solana";
    case "deposit":
    case "withdraw": {
      if (previousDestination) return previousDestination;
      const networks = lendingNetworks(draft.protocol, draft.kind);
      return preferred(networks, context) ?? networks[0] ?? preferred(EVM_DEFAULT_NETWORKS, context) ?? "base";
    }
    case "bridge": {
      if (previousDestination) return previousDestination;
      if (context.defaultNetwork && context.defaultNetwork !== draft.toNetwork) return context.defaultNetwork;
      throw clauseError(draft.clause, `Say where the funds come from, e.g. "from base to ${draft.toNetwork ?? "solana"}".`);
    }
    default:
      return previousDestination ?? inferSwapNetwork(draft, context);
  }
}

function toActionSpec(draft: Draft, network: NetworkKey, index: number): IntentActionSpec {
  const amount = draft.amount;
  if (draft.kind === "withdraw") {
    if (amount.type === "previous" && !amount.whole) {
      throw clauseError(draft.clause, "Withdraw an exact amount or \"all\" (the whole position).");
    }
    if (!draft.from) throw clauseError(draft.clause, "Say which asset to withdraw, e.g. \"withdraw 50 USDC from aave\".");
    if (amount.type === "exact" && amount.usd && !["USDC", "USDT", "PYUSD", "DAI"].includes(draft.from.toUpperCase())) {
      throw clauseError(draft.clause, "A $ amount must be withdrawn in a USD stablecoin.");
    }
  } else if (amount.type === "previous" && index === 0) {
    throw clauseError(draft.clause, "\"all\", \"half\", \"it\" and percentages refer to a previous step; give an explicit amount.");
  }
  let from = draft.from;
  if (amount.type === "exact" && amount.usd) {
    if (from && !["USDC", "USDT", "PYUSD", "DAI"].includes(from.toUpperCase())) {
      throw clauseError(draft.clause, "A $ amount must be paid in a USD stablecoin.");
    }
    from = from ?? "USDC";
  }
  const params: Record<string, string | number | boolean> = {};
  if (amount.type === "previous" && amount.portionBps !== 10_000) params.portionBps = amount.portionBps;
  if (draft.venue) params.venue = draft.venue;
  let to = draft.to;
  if (draft.kind === "stake") {
    const target = LIQUID_STAKING_TOKENS[draft.lst ?? "jito"] ?? LIQUID_STAKING_TOKENS.jito;
    to = target?.symbol ?? "JitoSOL";
    params.provider = target?.provider ?? "Jito";
  }
  if (draft.kind === "transfer" && !draft.recipient) throw clauseError(draft.clause, "A recipient address is required.");
  if (draft.kind === "bridge" && !draft.toNetwork) throw clauseError(draft.clause, "A destination network is required.");
  if (draft.kind === "bridge" && draft.toNetwork === network) {
    throw clauseError(draft.clause, "The source and destination networks are the same; use swap or send instead.");
  }
  return {
    kind: draft.kind,
    network,
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    amount: amount.type === "exact" ? amount.value : "max",
    ...(draft.toNetwork ? { toNetwork: draft.toNetwork } : {}),
    ...(draft.recipient ? { recipient: draft.recipient } : {}),
    ...(draft.protocol ? { protocol: draft.protocol } : {}),
    ...(Object.keys(params).length > 0 ? { params } : {}),
  };
}

/** Compiles intent text into structured actions, or throws INTENT_UNSUPPORTED. */
export function compileIntentText(text: string, context: GrammarContext = {}): GrammarResult {
  const normalizedText = normalizeText(text);
  if (!normalizedText) throw unsupported("The intent text is empty.", GRAMMAR_EXAMPLES);
  const clauses = splitClauses(normalizedText);
  if (clauses.length === 0) throw unsupported("The intent text is empty.", GRAMMAR_EXAMPLES);
  if (clauses.length > MAX_INTENT_ACTIONS) {
    throw unsupported(`An intent may contain at most ${MAX_INTENT_ACTIONS} actions.`, GRAMMAR_EXAMPLES);
  }
  const accountNetworks = (context.accounts ?? [])
    .map((account) => parseAccountId(account)?.chain.key)
    .filter((network): network is NetworkKey => network !== undefined);
  const inference: InferenceContext = {
    ...(context.defaultNetwork ? { defaultNetwork: context.defaultNetwork } : {}),
    accountNetworks,
  };
  const actions: IntentActionSpec[] = [];
  let previousDestination: NetworkKey | undefined;
  clauses.forEach((clause, index) => {
    const draft = matchClause(clause);
    const network = inferNetwork(draft, previousDestination, inference);
    const action = toActionSpec(draft, network, index);
    actions.push(action);
    previousDestination = action.toNetwork ?? action.network;
  });
  return {
    actions,
    normalizedText: clauses.join(", then "),
    clauses,
    confidence: 0.95,
  };
}
