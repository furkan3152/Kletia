/**
 * The assistant eval (docs/platform/assistant.md "Eval"): a corpus of
 * questions over fixture wallets with the facts and answers expected, run
 * offline on the deterministic path through a fixture data port, and the
 * gates: no ungrounded number in any answer, no answer that mentions another
 * fixture wallet, and at least 90% correct.
 *
 * The corpus wallets are recorded data API reads (core data.ts shapes, kept
 * compact): holdings as [network, symbol, amount] priced from the corpus
 * prices, positions and health, the on-chain history as `DataTransaction`
 * rows with per-network coverage (a provider not configured, Alchemy without
 * fees), FIFO PnL by asset, snapshots, and the positions' extras (perps, open
 * orders, automations, prediction positions). They are served through the
 * assistant's real port (`dataApiPort`), so the eval exercises the same
 * mapping, paging and coverage handling as the API.
 */
import { readFileSync } from "node:fs";
import {
  CHAINS,
  explorerTxUrl,
  findAssetBySymbol,
  formatAccountId,
  getProtocol,
  parseAccountId,
  type AccountId,
  type AssistantAnswer,
  type DataAllocationSlice,
  type DataAutomationRow,
  type DataFailure,
  type DataHolding,
  type DataOrderRow,
  type DataPerpRow,
  type DataPnlAsset,
  type DataPortfolio,
  type DataPosition,
  type DataPositionKind,
  type DataPositions,
  type DataPredictionRow,
  type DataSection,
  type DataTransaction,
  type DataTxCoverage,
  type DataTxKind,
  type DataTxProvider,
  type DataWalletSet,
  type DataYieldRow,
  type LendingHealth,
  type NetworkKey,
  type ProtocolId,
} from "@kletia/core";
import { laneAccounts } from "../data/wallets.js";
import { dataApiPort, type AssistantDataPort, type AssistantDataReader, type HistoryAccess } from "./dataPort.js";
import { checkGrounding, groundingContext } from "./grounding.js";
import { ask } from "./service.js";

export const ASSISTANT_EVAL_SPEC = "kletia.assistant-eval/v1";

export const ASSISTANT_EVAL_GATES = Object.freeze({ minCorrectBps: 9_000, maxUngrounded: 0, maxLeaks: 0, minQuestions: 60 });

/** A transaction leg: direction, symbol, decimal amount (null: unknown decimals), USD at the time (null: no price). */
type FixtureLeg = readonly [direction: "in" | "out", symbol: string, amount: string | null, usd: number | null];

export interface FixtureWallet {
  readonly evm: readonly string[];
  readonly solana: readonly string[];
  readonly holdings: readonly (readonly [network: NetworkKey, symbol: string, amount: string])[];
  readonly positions?: readonly {
    readonly network: NetworkKey;
    readonly protocol: ProtocolId;
    readonly venue: string;
    readonly name: string;
    readonly kind: DataPositionKind;
    readonly symbol: string;
    readonly amount: string | null;
    readonly usd: number | null;
    readonly apy?: number;
  }[];
  readonly health?: readonly { readonly network: NetworkKey; readonly protocol: ProtocolId; readonly market: string; readonly healthFactor: number | null; readonly status: LendingHealth["status"]; readonly reason?: string }[];
  readonly failures?: readonly DataFailure[];
  /** A desk session with tracking off ("untracked"), else the history is readable (an API key, or a tracked set). */
  readonly access?: "tracked" | "untracked";
  /** How each network's history reads (default: Etherscan for EVM, Helius for Solana, all `ok`). */
  readonly coverage?: Readonly<Partial<Record<NetworkKey, { readonly status: DataTxCoverage["status"]; readonly provider?: DataTxProvider | null; readonly reason?: string; readonly env?: readonly string[] }>>>;
  /** The on-chain history as the data API returns it (`DataTransaction`, compacted). */
  readonly transactions?: readonly {
    readonly hash: string;
    readonly at: string;
    readonly kind: DataTxKind;
    readonly network: NetworkKey;
    readonly status?: DataTransaction["status"];
    readonly legs: readonly FixtureLeg[];
    /** [symbol, amount, usd]; null when someone else paid. */
    readonly fee: readonly [symbol: string, amount: string, usd: number | null] | null;
    readonly feeReason?: string;
    readonly protocol?: ProtocolId;
    readonly method?: string;
  }[];
  /** FIFO results by asset as `GET /v1/data/pnl` returns them (one reading for every period). */
  readonly pnl?: {
    readonly assets: readonly { readonly key: string; readonly symbol: string; readonly realized: number | null; readonly unrealized: number | null; readonly cost: number | null; readonly reason?: string }[];
    readonly complete?: boolean;
  };
  /** The tracked set's value change over any range (snapshots). */
  readonly valueChange?: number;
  readonly perps?: readonly Omit<DataPerpRow, "account" | "marketId" | "sizeBase" | "collateralUsd">[];
  readonly perpsReason?: string;
  readonly orders?: readonly Omit<DataOrderRow, "owner">[];
  readonly automations?: readonly DataAutomationRow[];
  readonly predictions?: readonly Pick<DataPredictionRow, "title" | "outcome" | "shares" | "avgPrice" | "currentPrice" | "costUsd" | "valueUsd" | "pnlUsd" | "redeemable">[];
}

export interface AssistantEvalQuestion {
  readonly id: string;
  readonly family: string;
  readonly wallet: string;
  readonly ask: string;
  readonly expect: {
    readonly status: AssistantAnswer["status"] | readonly AssistantAnswer["status"][];
    readonly route?: AssistantAnswer["route"];
    readonly subject?: string;
    readonly aggregate?: string;
    readonly window?: string;
    /** Fact label -> printed value, each must be present exactly. */
    readonly facts?: Readonly<Record<string, string>>;
    /** Regexes the text must match. */
    readonly text?: readonly string[];
    /** Regexes the text must not match. */
    readonly notText?: readonly string[];
    /** Regexes, each matched by at least one gap line. */
    readonly gaps?: readonly string[];
    /** Fact labels that must carry a link (a transaction's History row, a deposit sentence). */
    readonly links?: readonly string[];
    /** Regexes, one per expected action sentence, in order. */
    readonly sentences?: readonly string[];
    readonly noAction?: true;
    readonly assumed?: true;
  };
}

export interface AssistantEvalCorpus {
  readonly spec: typeof ASSISTANT_EVAL_SPEC;
  readonly now: string;
  readonly prices: Readonly<Record<string, number>>;
  readonly yields: readonly { readonly venue: string; readonly network: NetworkKey; readonly protocol: ProtocolId; readonly name: string; readonly asset: string; readonly apy: number | null; readonly executable?: boolean }[];
  readonly wallets: Readonly<Record<string, FixtureWallet>>;
  /** Strings unique to a wallet (amounts, values) that must never appear in another wallet's answers. */
  readonly markers: Readonly<Record<string, readonly string[]>>;
  readonly questions: readonly AssistantEvalQuestion[];
}

export function loadAssistantCorpus(path: string): AssistantEvalCorpus {
  const corpus = JSON.parse(readFileSync(path, "utf8")) as AssistantEvalCorpus;
  if (corpus.spec !== ASSISTANT_EVAL_SPEC) throw new Error(`${path}: spec must be ${ASSISTANT_EVAL_SPEC}`);
  const ids = new Set<string>();
  for (const question of corpus.questions) {
    if (ids.has(question.id)) throw new Error(`${path}: duplicate id ${question.id}`);
    ids.add(question.id);
    if (!corpus.wallets[question.wallet]) throw new Error(`${question.id}: unknown wallet ${question.wallet}`);
    for (const pattern of [...(question.expect.text ?? []), ...(question.expect.notText ?? []), ...(question.expect.sentences ?? []), ...(question.expect.gaps ?? [])]) new RegExp(pattern, "u");
  }
  return corpus;
}

/* ------------------------------------------------------------ fixture port */

const round2 = (value: number) => Math.round(value * 100) / 100;

function priceOf(corpus: AssistantEvalCorpus, network: NetworkKey, symbol: string): number | null {
  const direct = corpus.prices[symbol];
  if (direct !== undefined) return direct;
  const asset = findAssetBySymbol(network, symbol);
  if (asset?.category === "stablecoin" && !/^EUR/u.test(asset.symbol)) return 1;
  if (asset?.group === "ETH") return corpus.prices.ETH ?? null;
  return null;
}

export function walletSetOf(wallet: FixtureWallet): DataWalletSet {
  return { evm: wallet.evm, solana: wallet.solana, lane: "production", accounts: laneAccounts(wallet.evm, wallet.solana, "production") };
}

function accountOf(wallet: FixtureWallet, network: NetworkKey): AccountId {
  const chain = CHAINS[network];
  return formatAccountId(chain, (chain.namespace === "solana" ? wallet.solana[0] : wallet.evm[0]) as string);
}

function slices(rows: readonly { key: string; label: string; usd: number }[]): DataAllocationSlice[] {
  const total = rows.reduce((sum, row) => sum + row.usd, 0);
  const merged = new Map<string, { key: string; label: string; usd: number }>();
  for (const row of rows) {
    const entry = merged.get(row.key) ?? { key: row.key, label: row.label, usd: 0 };
    entry.usd += row.usd;
    merged.set(row.key, entry);
  }
  return [...merged.values()].map((row) => ({ ...row, usd: round2(row.usd), share: total > 0 ? row.usd / total : 0 })).sort((a, b) => b.usd - a.usd);
}

function portfolioOf(corpus: AssistantEvalCorpus, wallet: FixtureWallet): DataPortfolio {
  const asOf = corpus.now;
  const holdings: DataHolding[] = wallet.holdings.map(([network, symbol, amount]) => {
    const price = priceOf(corpus, network, symbol);
    const asset = findAssetBySymbol(network, symbol);
    return {
      account: accountOf(wallet, network),
      network,
      asset: (asset?.id ?? `${CHAINS[network].id}/token:${symbol}`) as DataHolding["asset"],
      symbol,
      amount,
      formatted: amount,
      value: price === null ? { usd: null, source: "unpriced", asOf: null, reason: "No price source covers this asset." } : { usd: round2(price * Number(amount)), source: "chainlink", asOf },
    };
  });
  const positions: DataPosition[] = (wallet.positions ?? []).map((position) => ({
    id: position.venue,
    account: accountOf(wallet, position.network),
    network: position.network,
    protocol: position.protocol,
    name: position.name,
    kind: position.kind,
    symbol: position.symbol,
    amount: position.amount,
    value: { usd: position.usd, source: position.kind === "borrow" ? "aave-oracle" : "adapter", asOf },
    apy: position.apy ?? null,
    inWallet: false,
  }));
  const health: LendingHealth[] = (wallet.health ?? []).map((entry) => ({ ...entry, account: accountOf(wallet, entry.network), source: "aave-oracle", asOf }));
  const failures = wallet.failures ?? [];
  const sum = (values: readonly (number | null)[]) => round2(values.reduce<number>((total, value) => total + (value ?? 0), 0));
  const walletUsd = sum(holdings.map((holding) => holding.value.usd));
  const positionsUsd = sum(positions.filter((position) => position.kind !== "borrow").map((position) => position.value.usd));
  const debtUsd = sum(positions.filter((position) => position.kind === "borrow").map((position) => position.value.usd));
  const unpriced = holdings.filter((holding) => holding.value.usd === null).length;
  const priced = [
    ...holdings.filter((holding) => holding.value.usd !== null).map((holding) => ({ network: holding.network, symbol: holding.symbol, protocol: "wallet", usd: holding.value.usd as number })),
    ...positions.filter((position) => position.kind !== "borrow" && position.value.usd !== null).map((position) => ({ network: position.network, symbol: position.symbol, protocol: position.protocol as string, usd: position.value.usd as number })),
  ];
  const set = walletSetOf(wallet);
  return {
    wallets: { evm: set.evm, solana: set.solana, lane: set.lane },
    accounts: set.accounts,
    totals: {
      net: { usd: round2(walletUsd + positionsUsd - debtUsd), source: "kletia", asOf },
      wallet: { usd: walletUsd, source: "kletia", asOf },
      positions: { usd: positionsUsd, source: "kletia", asOf },
      debt: { usd: debtUsd, source: "kletia", asOf },
      unpriced,
      complete: unpriced === 0 && failures.length === 0,
    },
    change24h: { usd: null, pct: null, since: null, source: "snapshot", estimate: true, reason: "No reading 24 hours ago." },
    pnl: { usd: null, pct: null, since: null, source: "snapshot", estimate: true, reason: "No earlier reading." },
    allocation: {
      byNetwork: slices(priced.map((row) => ({ key: row.network, label: CHAINS[row.network].name, usd: row.usd }))),
      byAsset: slices(priced.map((row) => ({ key: row.symbol.toUpperCase(), label: row.symbol, usd: row.usd }))),
      byProtocol: slices(priced.map((row) => ({ key: row.protocol, label: row.protocol, usd: row.usd }))),
    },
    holdings,
    positions,
    health,
    failures,
    asOf,
  };
}

function coverageOf(wallet: FixtureWallet): DataTxCoverage[] {
  return walletSetOf(wallet).accounts.map((account) => {
    const network = parseAccountId(account)!.chain.key;
    const override = wallet.coverage?.[network];
    const provider = override?.provider !== undefined ? override.provider : CHAINS[network].vm === "svm" ? "helius" : "etherscan";
    return { account, network, provider, status: override?.status ?? "ok", ...(override?.reason ? { reason: override.reason } : {}), ...(override?.env ? { env: override.env } : {}) };
  });
}

function transactionsOf(wallet: FixtureWallet): DataTransaction[] {
  const asset = (network: NetworkKey, symbol: string) => {
    const listed = findAssetBySymbol(network, symbol);
    return { symbol, address: listed?.address ?? null, decimals: listed?.decimals ?? null, id: listed?.id ?? null };
  };
  return (wallet.transactions ?? []).map((tx) => ({
    id: `${tx.network}:${tx.hash}`,
    network: tx.network,
    hash: tx.hash,
    account: accountOf(wallet, tx.network),
    time: tx.at,
    block: null,
    kind: tx.kind,
    status: tx.status ?? "success",
    legs: tx.legs.map(([direction, symbol, amount, usd]) => ({ asset: asset(tx.network, symbol), amount, direction, usdAtTime: usd, priceSource: usd === null ? null : "defillama", ...(usd === null ? { reason: "No historical price was found." } : {}) })),
    fee: tx.fee ? { asset: asset(tx.network, tx.fee[0]), amount: tx.fee[1], usd: tx.fee[2], ...(tx.feeReason ? { reason: tx.feeReason } : tx.fee[2] === null ? { reason: "No historical price was found." } : {}) } : null,
    counterparty: null,
    protocol: tx.protocol ? { id: tx.protocol, label: getProtocol(tx.protocol)?.name ?? tx.protocol, role: null } : null,
    method: tx.method ?? null,
    kletiaIntentId: null,
    kletiaReceiptId: null,
    source: CHAINS[tx.network].vm === "svm" ? "helius" : "etherscan",
    explorerUrl: explorerTxUrl(tx.network, tx.hash),
  }));
}

const section = <T>(source: DataSection<T>["source"], rows: readonly T[], reason: string | null, asOf: string): DataSection<T> => ({ rows, reason, source, asOf });

/**
 * The data API of a corpus wallet, as recorded fixtures: the same shapes as
 * data/api.ts (portfolio, positions with extras, a cursor-paged on-chain
 * history with per-account coverage, FIFO PnL and snapshots). No network.
 */
export function fixtureReader(corpus: AssistantEvalCorpus, wallet: FixtureWallet): AssistantDataReader {
  const asOf = corpus.now;
  const portfolio = portfolioOf(corpus, wallet);
  const coverage = coverageOf(wallet);
  const readable = new Set(coverage.filter((entry) => entry.provider !== null && entry.status !== "failed").map((entry) => entry.account));
  const history = transactionsOf(wallet).filter((tx) => readable.has(tx.account)).sort((a, b) => b.time.localeCompare(a.time));
  const evmAccount = (network: NetworkKey) => (wallet.evm[0] ? formatAccountId(CHAINS[network], wallet.evm[0]) : null);
  return {
    portfolio: async () => portfolio,
    async positions(_scope, options) {
      const base: DataPositions = { accounts: portfolio.accounts, positions: portfolio.positions, health: portfolio.health, failures: portfolio.failures, asOf };
      if (!options.extras) return base;
      return {
        ...base,
        extras: {
          perps: section("perps", (wallet.perps ?? []).map((row) => ({ ...row, account: accountOf(wallet, row.network), marketId: row.symbol, sizeBase: 0, collateralUsd: null })), wallet.perpsReason ?? null, asOf),
          orders: section("orders", (wallet.orders ?? []).map((row) => ({ ...row, owner: wallet.evm[0] ?? wallet.solana[0] ?? "" })), null, asOf),
          automations: section("automations", wallet.automations ?? [], null, asOf),
          agentSpend: section("policy", [], "Agent key spend is shown to API keys only.", asOf),
          predictions: section("predictions", (wallet.predictions ?? []).map((row, index) => ({
            ...row, venue: "polymarket" as const, holder: wallet.evm[0] ?? "", account: evmAccount("polygon") as AccountId, conditionId: `0x${String(index + 1).padStart(64, "0")}`,
            tokenId: String(index + 1), slug: null, eventSlug: null, outcomeIndex: 0, negRisk: false, endDate: null,
          })), null, asOf),
        },
      };
    },
    async transactions(_scope, query) {
      const rows = history.filter((tx) => (!query.from || tx.time >= query.from) && (!query.to || tx.time <= query.to) && (!query.kind || tx.kind === query.kind) && (!query.network || tx.network === query.network));
      const start = query.cursor ? Number(query.cursor) : 0;
      const limit = query.limit ?? 50;
      const page = rows.slice(start, start + limit);
      return { transactions: page, cursor: start + limit < rows.length ? String(start + limit) : null, coverage, asOf };
    },
    async pnl(_scope, query) {
      const assets: DataPnlAsset[] = (wallet.pnl?.assets ?? []).map((row) => ({
        key: row.key, symbol: row.symbol, openQuantity: 0, costBasisUsd: row.cost, realizedUsd: row.realized, unrealizedUsd: row.unrealized,
        currentUsd: row.cost !== null && row.unrealized !== null ? round2(row.cost + row.unrealized) : null, ...(row.reason ? { reason: row.reason } : {}),
      }));
      const known = (values: readonly (number | null)[]) => values.every((value) => value !== null);
      const sum = (values: readonly (number | null)[]) => round2(values.reduce<number>((total, value) => total + (value ?? 0), 0));
      return {
        period: query.period,
        since: null,
        method: "fifo",
        estimate: true,
        assets,
        totals: { realizedUsd: sum(assets.map((row) => row.realizedUsd)), unrealizedUsd: sum(assets.map((row) => row.unrealizedUsd)), complete: (wallet.pnl?.complete ?? true) && coverage.every((entry) => entry.status === "ok") && known(assets.map((row) => row.realizedUsd)) && known(assets.map((row) => row.unrealizedUsd)) },
        coverage,
        source: "fifo",
        asOf,
      };
    },
    async snapshots(_scope, query) {
      const change = wallet.valueChange ?? null;
      return { range: query.range, points: [], change: change === null ? null : { usd: change, pct: null }, tracked: wallet.access !== "untracked", source: "snapshot", asOf, ...(change === null ? { reason: "No earlier reading of these wallets." } : {}) };
    },
    async yields(filter) {
      const rows: DataYieldRow[] = corpus.yields
        .filter((row) => (!filter.network || row.network === filter.network) && (!filter.asset || row.asset.toUpperCase() === filter.asset.toUpperCase()))
        .map((row) => ({ venue: row.venue, protocol: row.protocol, network: row.network, name: row.name, asset: row.asset, apy: row.apy, apyBasis: row.apy === null ? "unavailable" : "rate", supplied: null, utilization: null, executable: row.executable ?? true, depositText: `Deposit [EDIT AMOUNT] ${row.asset} into ${row.name} on ${CHAINS[row.network].name}`, source: "lending-metrics", asOf }));
      return { yields: rows, failures: [], asOf };
    },
    async prices(symbols) {
      return { prices: symbols.map((symbol) => ({ symbol, network: null, asset: null, value: corpus.prices[symbol] === undefined ? { usd: null, source: "unpriced", asOf: null } : { usd: corpus.prices[symbol] as number, source: "chainlink", asOf } })), asOf };
    },
  };
}

/** The scope a corpus wallet is read under: a tracked desk session's (or an API key's) open history, or a desk session with tracking off. */
export function fixtureAccess(wallet: FixtureWallet): HistoryAccess {
  const set = walletSetOf(wallet);
  return {
    scope: { wallets: set, viewer: { kind: "public" }, tracking: null, automationOwner: null, keyAuth: null },
    history: wallet.access === "untracked" ? "tracking-off" : "open",
  };
}

/** The corpus wallet behind the assistant's real data port (dataApiPort), read from the recorded fixtures. */
export function fixturePort(corpus: AssistantEvalCorpus, wallet: FixtureWallet): AssistantDataPort {
  const now = Date.parse(corpus.now);
  return dataApiPort(fixtureAccess(wallet), fixtureReader(corpus, wallet), () => now);
}

/* ------------------------------------------------------------ run and score */

export interface AssistantEvalRow {
  readonly question: AssistantEvalQuestion;
  readonly answer: AssistantAnswer;
  readonly correct: boolean;
  readonly misses: readonly string[];
  readonly ungrounded: readonly string[];
  readonly leaks: readonly string[];
}

/** What an answer got wrong against its expectation (empty when correct). */
export function checkExpectation(question: AssistantEvalQuestion, answer: AssistantAnswer): string[] {
  const expect = question.expect;
  const misses: string[] = [];
  const statuses = typeof expect.status === "string" ? [expect.status] : expect.status;
  if (!statuses.includes(answer.status)) misses.push(`status ${answer.status} (want ${statuses.join("|")})`);
  if (expect.route !== undefined && answer.route !== expect.route) misses.push(`route ${answer.route}`);
  if (expect.subject && answer.query?.subject !== expect.subject) misses.push(`subject ${answer.query?.subject ?? "none"}`);
  if (expect.aggregate && answer.query?.aggregate !== expect.aggregate) misses.push(`aggregate ${answer.query?.aggregate ?? "none"}`);
  if (expect.window && answer.query?.window?.name !== expect.window) misses.push(`window ${answer.query?.window?.name ?? "none"}`);
  if (expect.assumed && answer.assumptions.length === 0) misses.push("no assumption stated");
  for (const [label, value] of Object.entries(expect.facts ?? {})) {
    const fact = answer.facts.find((entry) => entry.label === label);
    if (!fact) misses.push(`fact "${label}" missing`);
    else if (fact.value !== value) misses.push(`fact "${label}" = ${fact.value} (want ${value})`);
  }
  for (const pattern of expect.text ?? []) if (!new RegExp(pattern, "u").test(answer.text)) misses.push(`text !~ ${pattern}`);
  for (const pattern of expect.notText ?? []) if (new RegExp(pattern, "u").test(answer.text)) misses.push(`text ~ ${pattern}`);
  for (const pattern of expect.gaps ?? []) if (!answer.gaps.some((gap) => new RegExp(pattern, "u").test(gap))) misses.push(`no gap ~ ${pattern}`);
  for (const label of expect.links ?? []) if (!answer.facts.find((fact) => fact.label === label)?.link) misses.push(`fact "${label}" has no link`);
  if (expect.noAction && answer.action) misses.push("unexpected action");
  if (expect.sentences) {
    const sentences = answer.action?.sentences ?? [];
    if (sentences.length !== expect.sentences.length) misses.push(`${sentences.length} sentences (want ${expect.sentences.length})`);
    expect.sentences.forEach((pattern, index) => {
      if (!new RegExp(pattern, "u").test(sentences[index] ?? "")) misses.push(`sentence ${index + 1} "${sentences[index] ?? ""}" !~ ${pattern}`);
    });
  }
  return misses;
}

/** Other wallets' addresses and markers found anywhere in the answer. */
export function leaksOf(corpus: AssistantEvalCorpus, walletId: string, answer: AssistantAnswer): string[] {
  const own = corpus.wallets[walletId] as FixtureWallet;
  const json = JSON.stringify(answer).toLowerCase();
  const out: string[] = [];
  for (const [id, wallet] of Object.entries(corpus.wallets)) {
    if (id === walletId) continue;
    for (const address of [...wallet.evm, ...wallet.solana]) {
      if ([...own.evm, ...own.solana].some((mine) => mine.toLowerCase() === address.toLowerCase())) continue;
      if (json.includes(address.toLowerCase())) out.push(`${id} address`);
    }
    for (const marker of corpus.markers[id] ?? []) if (json.includes(marker.toLowerCase())) out.push(`${id} marker ${marker}`);
  }
  return out;
}

export async function runAssistantEval(corpus: AssistantEvalCorpus, filter?: (question: AssistantEvalQuestion) => boolean): Promise<AssistantEvalRow[]> {
  const now = Date.parse(corpus.now);
  const rows: AssistantEvalRow[] = [];
  for (const question of corpus.questions) {
    if (filter && !filter(question)) continue;
    const wallet = corpus.wallets[question.wallet] as FixtureWallet;
    const answer = await ask({ question: question.ask, set: walletSetOf(wallet), port: fixturePort(corpus, wallet), model: null, modelUnavailable: "off", now });
    const misses = checkExpectation(question, answer);
    const grounding = checkGrounding(answer.text, answer.facts, groundingContext(answer.query, answer.assumptions), { quotedExamples: answer.wording === "template" });
    const leaks = leaksOf(corpus, question.wallet, answer);
    rows.push({ question, answer, correct: misses.length === 0, misses, ungrounded: grounding.problems, leaks });
  }
  return rows;
}

export interface AssistantGate {
  readonly gate: string;
  readonly ok: boolean;
  readonly detail: string;
}

export function assistantGates(rows: readonly AssistantEvalRow[]): AssistantGate[] {
  const gates = ASSISTANT_EVAL_GATES;
  const correct = rows.filter((row) => row.correct).length;
  const ungrounded = rows.filter((row) => row.ungrounded.length > 0).length;
  const leaks = rows.filter((row) => row.leaks.length > 0).length;
  return [
    { gate: "questions", ok: rows.length >= gates.minQuestions, detail: `${rows.length} (needs ≥ ${gates.minQuestions})` },
    { gate: "correct", ok: rows.length > 0 && correct * 10_000 >= gates.minCorrectBps * rows.length, detail: `${correct}/${rows.length} = ${((100 * correct) / Math.max(1, rows.length)).toFixed(1)}% (needs ≥ ${gates.minCorrectBps / 100}%)` },
    { gate: "ungrounded", ok: ungrounded <= gates.maxUngrounded, detail: `${ungrounded} answers (needs ${gates.maxUngrounded})` },
    { gate: "cross-wallet leaks", ok: leaks <= gates.maxLeaks, detail: `${leaks} answers (needs ${gates.maxLeaks})` },
  ];
}
