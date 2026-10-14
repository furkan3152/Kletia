/**
 * Test seam for the clarify corpus (`__tests__/fixtures/clarify-corpus.json`):
 * fixture wallets become holdings readers (configureHoldingsReaders), so the
 * engine reads its facts through holdings.readFacts exactly as in production,
 * with the budget, the cache and "unknown is never zero". Offline only:
 * nothing here touches a network.
 */
import { readFileSync } from "node:fs";
import { CHAINS, findAssetByAddress, toBaseUnits, type IntentActionSpec, type NetworkKey } from "@kletia/core";
import { isPlatformError } from "../../errors.js";
import type { ContractPhrase } from "../contracts/directory.js";
import { compileIntentText } from "../grammar.js";
import { configureHoldingsReaders } from "../holdings.js";
import { decideTurn, type TurnDecision } from "./index.js";
import { stakeProvider } from "./catalog.js";
import type { ResolvedAction, TurnContext, TurnInput } from "./types.js";

export interface CorpusWallet {
  readonly about?: string;
  readonly accounts: readonly string[];
  readonly balances: Readonly<Record<string, Readonly<Record<string, string>>>> | null;
  readonly positions: Readonly<Record<string, string>> | null;
}

export interface CorpusTurn {
  readonly say?: string;
  readonly answer?: { readonly question: string; readonly option?: string; readonly text?: string };
  readonly assumption?: { readonly id: string; readonly option: string };
  readonly expect: Readonly<Record<string, unknown>>;
}

export interface CorpusCase {
  readonly id: string;
  readonly category: string;
  readonly title: string;
  readonly wallet: string;
  readonly request?: { readonly defaultNetwork?: NetworkKey; readonly sourceNetwork?: NetworkKey | "auto" };
  readonly phase?: number | string;
  readonly why?: string;
  readonly turns: readonly CorpusTurn[];
}

export interface Corpus {
  readonly spec: string;
  readonly fixtures: {
    readonly wallets: Readonly<Record<string, CorpusWallet>>;
    readonly names: Readonly<Record<string, Readonly<Record<string, string>>>>;
    readonly contracts: readonly { registration: string; entry: string; network: NetworkKey; vm: "evm" | "svm"; aliases: string[]; verbs: string[]; spends: boolean }[];
  };
  readonly cases: readonly CorpusCase[];
}

export function loadCorpus(path: string): Corpus {
  return JSON.parse(readFileSync(path, "utf8")) as Corpus;
}

export function corpusPhrases(corpus: Corpus): ContractPhrase[] {
  return corpus.fixtures.contracts.map((entry) => ({
    contract: entry.registration,
    entry: entry.entry,
    network: entry.network,
    vm: entry.vm,
    verbs: entry.verbs,
    aliases: entry.aliases,
    spends: entry.spends,
  }));
}

/** Installs a fixture wallet as the holdings readers (clears every holdings cache). */
export function installWallet(corpus: Corpus, walletId: string): { reads: { balances: number; names: number } } {
  const wallet = corpus.fixtures.wallets[walletId];
  if (!wallet) throw new Error(`unknown wallet ${walletId}`);
  const counter = { balances: 0, names: 0 };
  const balance = (network: NetworkKey, token: string | null): bigint => {
    counter.balances += 1;
    const row = wallet.balances?.[network];
    if (!row) throw new Error("unknown balance");
    const symbol = token === null ? CHAINS[network].nativeAsset.symbol : findAssetByAddress(network, token)?.symbol;
    if (!symbol) throw new Error("unlisted token");
    const key = Object.keys(row).find((entry) => entry.toUpperCase() === symbol.toUpperCase());
    if (!key) return 0n;
    const decimals = token === null ? CHAINS[network].nativeAsset.decimals : findAssetByAddress(network, token)?.decimals ?? 18;
    return BigInt(toBaseUnits(row[key] as string, decimals));
  };
  configureHoldingsReaders({
    evmBalance: async (network, _owner, token) => balance(network, token),
    solanaBalance: async (network, _owner, mint) => balance(network, mint),
    // Offline: the other chain facts are unknown (never a network read).
    gasPrice: async () => {
      throw new Error("offline");
    },
    solanaRent: async () => {
      throw new Error("offline");
    },
    solanaTokenAccountExists: async () => {
      throw new Error("offline");
    },
    resolveName: async (name, network) => {
      counter.names += 1;
      const entry = corpus.fixtures.names[name.toLowerCase()];
      const address = entry ? entry[network] ?? (CHAINS[network].vm === "evm" ? entry.evm : undefined) : undefined;
      if (!address) throw new Error("name not found");
      return { address, protocol: CHAINS[network].vm === "evm" ? (/\.base\.eth$/u.test(name) ? "basenames" : "ens") : "sns" } as never;
    },
  });
  return { reads: counter };
}

export function contextFor(corpus: Corpus, entry: CorpusCase): TurnContext {
  const wallet = corpus.fixtures.wallets[entry.wallet] as CorpusWallet;
  return {
    accounts: wallet.accounts,
    ...(entry.request?.defaultNetwork ? { defaultNetwork: entry.request.defaultNetwork } : {}),
    ...(entry.request?.sourceNetwork ? { sourceNetwork: entry.request.sourceNetwork } : {}),
    contracts: corpusPhrases(corpus),
  };
}

export function turnInputOf(turn: CorpusTurn): TurnInput {
  if (typeof turn.say === "string") return { text: turn.say };
  if (turn.answer) return { answer: turn.answer };
  return { assumption: turn.assumption as { id: string; option: string } };
}

/** The corpus' plan shape: kind@network[->toNetwork] amount from[->to][ to recipient][ [protocol[:vault]]][ {provider}][ <contract#entry>]. */
export function shape(actions: readonly ResolvedAction[]): string {
  return actions
    .map((a) => {
      const amount = a.amount === "max" ? (a.portionBps && a.portionBps !== 10_000 ? `max(${a.portionBps})` : "max") : a.amount;
      const to = a.to && a.to !== a.from ? `->${a.to}` : "";
      const recipient = a.recipient ? ` to ${a.recipient}` : "";
      const protocol = a.protocol && a.kind !== "stake" ? ` [${a.protocol}${a.vault ? `:${a.vault}` : ""}]` : "";
      const provider = a.provider ? ` {${a.provider}}` : "";
      const contract = a.contract ? ` <${a.contract}#${a.entry}>` : "";
      return `${a.kind}@${a.network}${a.toNetwork ? `->${a.toNetwork}` : ""} ${amount} ${a.from}${to}${recipient}${protocol}${provider}${contract}`;
    })
    .join(" | ");
}

export interface TurnRun {
  readonly decision?: TurnDecision;
  readonly error?: { readonly code: string; readonly message: string };
}

/** Runs one turn; refusals come back as `error` (the thread then stays as it was). */
export async function runTurn(thread: TurnDecision["thread"] | null, input: TurnInput, ctx: TurnContext): Promise<TurnRun> {
  try {
    return { decision: await decideTurn(thread, input, ctx) };
  } catch (error) {
    if (isPlatformError(error)) return { error: { code: error.code, message: error.message } };
    throw error;
  }
}

/** Differences between a ready decision's actions and what the grammar compiles its sentence into (empty: same). */
export function roundTripDifferences(actions: readonly ResolvedAction[], sentence: string, ctx: TurnContext): string[] {
  const compiled: IntentActionSpec[] = compileIntentText(sentence, { accounts: ctx.accounts as never, contracts: ctx.contracts }).actions;
  const out: string[] = [];
  if (compiled.length !== actions.length) return [`${compiled.length} steps compiled, ${actions.length} resolved`];
  compiled.forEach((spec, index) => {
    const mine = actions[index] as ResolvedAction;
    const at = `step ${index + 1}`;
    const check = (what: string, left: unknown, right: unknown) => {
      if (left !== right) out.push(`${at} ${what}: grammar ${String(left)} vs clarify ${String(right)}`);
    };
    check("kind", spec.kind, mine.kind);
    check("network", spec.network, mine.network);
    if (mine.toNetwork) check("toNetwork", spec.toNetwork, mine.toNetwork);
    check("amount", spec.amount ?? "", mine.amount);
    if (spec.from !== undefined) check("from", spec.from.toUpperCase(), mine.from.toUpperCase());
    else if (mine.amount !== "max" && mine.amount !== "") out.push(`${at}: only a dependent step omits from`);
    if (mine.kind === "swap" || (mine.kind === "bridge" && spec.to)) check("to", (spec.to ?? "").toUpperCase(), (mine.to ?? "").toUpperCase());
    if (mine.recipient) check("recipient", spec.recipient, mine.recipient);
    if (mine.protocol && mine.kind !== "stake") check("protocol", spec.protocol, mine.protocol);
    if (mine.vault) check("vault", spec.params?.venue, mine.vault);
    if (mine.portionBps && mine.portionBps !== 10_000) check("portion", spec.params?.portionBps, mine.portionBps);
    if (mine.kind === "stake") check("provider", spec.params?.provider, stakeProvider(mine.provider)?.grammarProvider);
    if (mine.contract) {
      check("contract", spec.contract, mine.contract);
      check("entry", spec.entry, mine.entry);
    }
  });
  return out;
}
