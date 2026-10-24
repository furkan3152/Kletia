/**
 * The assistant eval (docs/platform/assistant.md "Eval"): a corpus of
 * questions over fixture wallets with the facts and answers expected, run
 * offline on the deterministic path through a fixture data port, and the
 * gates: no ungrounded number in any answer, no answer that mentions another
 * fixture wallet, and at least 90% correct.
 *
 * The fixture port builds the same shapes as the data service (core data.ts)
 * from a compact corpus: holdings as [network, symbol, amount] priced from
 * the corpus prices, positions, health, transactions, PnL rows and yields.
 */
import { readFileSync } from "node:fs";
import {
  CHAINS,
  findAssetBySymbol,
  formatAccountId,
  type AccountId,
  type AssistantAnswer,
  type AssistantTxKind,
  type DataAllocationSlice,
  type DataFailure,
  type DataHolding,
  type DataPosition,
  type DataPositionKind,
  type DataWalletSet,
  type DataYieldRow,
  type LendingHealth,
  type NetworkKey,
  type ProtocolId,
} from "@kletia/core";
import { laneAccounts } from "../data/wallets.js";
import type { AssistantDataPort, AssistantPnlRow, AssistantSummary, AssistantTransaction } from "./dataPort.js";
import { checkGrounding, groundingContext } from "./grounding.js";
import { ask } from "./service.js";

export const ASSISTANT_EVAL_SPEC = "kletia.assistant-eval/v1";

export const ASSISTANT_EVAL_GATES = Object.freeze({ minCorrectBps: 9_000, maxUngrounded: 0, maxLeaks: 0, minQuestions: 60 });

type Leg = readonly [symbol: string, amount: string, usd: number | null];

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
  /** "chain": every transaction is known; "kletia": only Kletia's; "none": no history. */
  readonly history: "chain" | "kletia" | "none";
  readonly transactions?: readonly {
    readonly id: string;
    readonly at: string;
    readonly kind: AssistantTxKind;
    readonly network: NetworkKey;
    readonly destination?: NetworkKey;
    readonly protocol?: ProtocolId;
    readonly status?: AssistantTransaction["status"];
    readonly sent: readonly Leg[];
    readonly received: readonly Leg[];
    readonly fee: number | null;
    readonly hash?: string;
  }[];
  readonly pnl?: {
    readonly total: number | null;
    readonly assets: readonly { readonly symbol: string; readonly network?: NetworkKey; readonly usd: number; readonly pct: number | null }[];
    readonly positions: readonly { readonly label: string; readonly symbol: string; readonly network: NetworkKey; readonly protocol: ProtocolId; readonly kind: string; readonly earned: number | null }[];
    readonly reason?: string;
  };
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
    for (const pattern of [...(question.expect.text ?? []), ...(question.expect.notText ?? []), ...(question.expect.sentences ?? [])]) new RegExp(pattern, "u");
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

/** The corpus wallet behind the assistant's data port, as the data service would shape it. */
export function fixturePort(corpus: AssistantEvalCorpus, wallet: FixtureWallet): AssistantDataPort {
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
  const summary: AssistantSummary = {
    accounts: walletSetOf(wallet).accounts,
    totals: {
      net: { usd: round2(walletUsd + positionsUsd - debtUsd), source: "kletia", asOf },
      wallet: { usd: walletUsd, source: "kletia", asOf },
      positions: { usd: positionsUsd, source: "kletia", asOf },
      debt: { usd: debtUsd, source: "kletia", asOf },
      unpriced,
      complete: unpriced === 0 && failures.length === 0,
    },
    change24h: { usd: null, pct: null, since: null, source: "snapshot", estimate: true, reason: "No reading 24 hours ago." },
    pnl: { usd: wallet.pnl?.total ?? null, pct: null, since: null, source: "snapshot", estimate: true },
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
  const leg = ([symbol, amount, usd]: Leg) => ({ symbol, amount, usd });
  const transactions: AssistantTransaction[] = (wallet.transactions ?? []).map((tx) => ({
    id: tx.id,
    at: tx.at,
    kind: tx.kind,
    account: accountOf(wallet, tx.network),
    network: tx.network,
    destination: tx.destination ?? null,
    protocol: tx.protocol ?? null,
    status: tx.status ?? "confirmed",
    sent: tx.sent.map(leg),
    received: tx.received.map(leg),
    fee: tx.fee === null ? { usd: null, source: "chain", asOf: tx.at, reason: "No fee reading." } : { usd: tx.fee, source: "chain", asOf: tx.at },
    hash: tx.hash ?? null,
    source: "chain",
  }));
  return {
    summary: async () => summary,
    positions: async () => ({ accounts: summary.accounts, positions, health, failures, asOf }),
    async transactions(_set, query) {
      if (wallet.history === "none") return { transactions: [], coverage: "none", complete: false, reason: "On-chain transaction history is not connected yet.", asOf };
      const rows = transactions.filter((tx) => (!query.from || tx.at >= query.from) && (!query.to || tx.at < query.to)).sort((a, b) => b.at.localeCompare(a.at));
      return { transactions: rows, coverage: wallet.history, complete: wallet.history === "chain", ...(wallet.history === "kletia" ? { reason: "Only transactions Kletia planned are known." } : {}), asOf };
    },
    async pnl(_set, query) {
      const pnl = wallet.pnl;
      const rows: AssistantPnlRow[] = !pnl ? [] : query.by === "asset"
        ? pnl.assets.map((row) => ({ key: `${row.network ?? ""}:${row.symbol}`, label: row.symbol, symbol: row.symbol, network: row.network ?? null, protocol: null, kind: null, change: { usd: row.usd, source: "snapshot", asOf }, pct: row.pct, earned: null }))
        : pnl.positions.map((row) => ({ key: `${row.network}:${row.protocol}:${row.symbol}`, label: row.label, symbol: row.symbol, network: row.network, protocol: row.protocol, kind: row.kind, change: { usd: null, source: "snapshot", asOf }, pct: null, earned: { usd: row.earned, source: "adapter", asOf } }));
      return { rows, total: { usd: pnl?.total ?? null, source: "snapshot", asOf, ...(pnl ? {} : { reason: "No earlier reading." }) }, estimate: true, ...(pnl?.reason ? { reason: pnl.reason } : !pnl ? { reason: "No price history for these wallets." } : {}), asOf };
    },
    snapshots: async () => ({ points: [], source: "snapshot", reason: "No earlier reading.", asOf }),
    async yields(filter) {
      const rows: DataYieldRow[] = corpus.yields
        .filter((row) => (!filter.network || row.network === filter.network) && (!filter.asset || row.asset.toUpperCase() === filter.asset.toUpperCase()))
        .map((row) => ({ venue: row.venue, protocol: row.protocol, network: row.network, name: row.name, asset: row.asset, apy: row.apy, apyBasis: row.apy === null ? "unavailable" : "rate", supplied: null, utilization: null, executable: row.executable ?? true, depositText: "", source: "lending-metrics", asOf }));
      return { yields: rows, failures: [], asOf };
    },
    async prices(symbols) {
      return { prices: symbols.map((symbol) => ({ symbol, network: null, asset: null, value: corpus.prices[symbol] === undefined ? { usd: null, source: "unpriced", asOf: null } : { usd: corpus.prices[symbol] as number, source: "chainlink", asOf } })), asOf };
    },
  };
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
