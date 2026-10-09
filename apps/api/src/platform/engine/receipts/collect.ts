/**
 * Receipt inputs (receipts design R2, §3.3, §4.4, §5.5, §16.2): the on-chain
 * anchors of a finished intent, read through the core readers over the
 * engine's RPC clients, gated on finality.
 *
 * - Origin anchors: every accepted reference of a step, in prepared order.
 * - Fill anchors: `settlement` evidence references on the step's destination
 *   network (Relay, LI.FI and deBridge fills). Provider ids are not anchors.
 * - EVM finality: the anchor's block is at or below the `finalized` head and
 *   the block at that height still has the anchor's hash, re-read after the
 *   head (a different hash is a reorg). Networks whose RPC serves no
 *   `finalized` tag fall back to `KLETIA_RECEIPT_CONFIRMATIONS_<NETWORK>`
 *   confirmations (`depth:<n>`), else the collection asks for a retry.
 * - Solana finality: the signature status is `finalized` and the finalized
 *   block at the anchor's slot has the anchor's blockhash.
 * - Landed bindings: the EVM quote binding the landed transactions reproduce,
 *   when it is one of the step's prepared bindings.
 *
 * Never issues anything and never reports "missing" as "does not exist":
 * unreadable data is `retry`, a moved block is `reorged`, a block not yet
 * final is `waiting_finality` with an `expectedBy` from the measured lag.
 * Read-only.
 */
import {
  AnchorUnavailableError,
  CHAINS,
  evmBindingView,
  isAnchorUnavailable,
  isReceiptableStatus,
  isSolanaSignature,
  parseAccountId,
  readEvmAnchor,
  readEvmBindingView,
  readSvmAnchor,
  RECEIPT_DIGEST_PATTERN,
  RECEIPT_SOLANA_MAX_TRANSACTION_VERSION,
  type AnchorRole,
  type CaipChainId,
  type EvmAnchor,
  type IntentGraph,
  type IntentStep,
  type NetworkKey,
  type ReceiptAnchor,
  type ReceiptCollection,
  type ReceiptFinalityHead,
  type ReceiptFinalityMode,
  type RpcTransport,
  type SvmAnchor,
} from "@kletia/core";
import { isSolanaNetworkKey, SOLANA_RPC_URLS, type SolanaNetworkKey } from "../../../networks/solana/index.js";
import { quoteBindingForViews } from "../binding.js";
import { evmClient, isEvmNetwork } from "../chains/evm.js";

/** Measured lag of the finalized head behind the latest head (receipts design §3.3, 2026-10-09), in seconds. */
export const RECEIPT_FINALITY_LAG_SECONDS: Readonly<Record<NetworkKey, number>> = Object.freeze({
  ethereum: 900,
  base: 950,
  arbitrum: 1_050,
  optimism: 1_200,
  polygon: 10,
  arc: 5,
  "arbitrum-sepolia": 1_150,
  solana: 15,
  "solana-devnet": 5,
} as Record<NetworkKey, number>);

const HEAD_TTL_MS = 30_000;
const EVM_HASH = /^0x[0-9a-fA-F]{64}$/u;

export interface CollectReceiptOptions {
  /** Clock (tests). */
  readonly now?: number;
  /** JSON-RPC transports by network (tests, operators); default: the engine's configured clients. */
  readonly transports?: Partial<Record<NetworkKey, RpcTransport>>;
}

/* -------------------------------------------------------------- transports */

class RpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
    this.name = "RpcError";
  }
}

function evmTransport(network: NetworkKey): RpcTransport {
  if (!isEvmNetwork(network)) throw new Error(`${network} is not an EVM network.`);
  const client = evmClient(network);
  return async (method, params) => client.request({ method: method as never, params: params as never });
}

function solanaTransport(network: SolanaNetworkKey): RpcTransport {
  return async (method, params) => {
    const response = await fetch(SOLANA_RPC_URLS[network], {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await response.json().catch(() => null)) as { result?: unknown; error?: { code?: unknown; message?: unknown } } | null;
    if (!body || typeof body !== "object") throw new Error(`HTTP ${response.status}: not JSON-RPC`);
    if (body.error) throw new RpcError(typeof body.error.code === "number" ? body.error.code : -1, String(body.error.message ?? "error").slice(0, 200));
    if (!("result" in body)) throw new Error(`HTTP ${response.status}: no result`);
    return body.result;
  };
}

function baseTransport(network: NetworkKey, options: CollectReceiptOptions): RpcTransport {
  const base = options.transports?.[network] ?? (isEvmNetwork(network) ? evmTransport(network) : isSolanaNetworkKey(network) ? solanaTransport(network) : null);
  if (!base) throw new Error(`No RPC transport for ${network}.`);
  return base;
}

/** One transport per network per collection, memoised per (method, params): the readers re-read some objects. */
function memoised(network: NetworkKey, base: RpcTransport, memo: Map<string, Promise<unknown>>): RpcTransport {
  return (method, params) => {
    const key = `${network}|${method}|${JSON.stringify(params)}`;
    const cached = memo.get(key);
    if (cached) return cached;
    const pending = base(method, params);
    memo.set(key, pending);
    pending.catch(() => memo.delete(key));
    return pending;
  };
}

/* ------------------------------------------------------------------ heads */

interface EvmHead {
  readonly block: bigint;
  readonly mode: ReceiptFinalityMode["mode"];
}

const evmHeads = new Map<string, { value: EvmHead; at: number }>();
const solanaHeads = new Map<string, { value: bigint; at: number }>();

/** Forgets cached finality heads (tests). */
export function resetReceiptHeads(): void {
  evmHeads.clear();
  solanaHeads.clear();
}

function confirmationsFallback(network: NetworkKey): number | null {
  const raw = process.env[`KLETIA_RECEIPT_CONFIRMATIONS_${network.toUpperCase().replace(/[^A-Z0-9]/gu, "_")}`]?.trim();
  const value = raw ? Number(raw) : Number.NaN;
  return Number.isSafeInteger(value) && value > 0 && value <= 100_000 ? value : null;
}

function finalityLag(network: NetworkKey): number {
  const raw = process.env[`KLETIA_RECEIPT_FINALITY_LAG_${network.toUpperCase().replace(/[^A-Z0-9]/gu, "_")}`]?.trim();
  const value = raw ? Number(raw) : Number.NaN;
  return Number.isSafeInteger(value) && value >= 0 ? value : RECEIPT_FINALITY_LAG_SECONDS[network] ?? 1_200;
}

function quantity(value: unknown): bigint | null {
  return typeof value === "string" && /^0x[0-9a-fA-F]+$/u.test(value) ? BigInt(value) : null;
}

/** The EVM finalized head (cached 30 s), or `latest − confirmations` where the tag is not served. Null: unknown. */
async function evmFinalizedHead(network: NetworkKey, rpc: RpcTransport, now: number, injected: boolean): Promise<EvmHead | null> {
  const cached = injected ? undefined : evmHeads.get(network);
  if (cached && now - cached.at < HEAD_TTL_MS) return cached.value;
  let head: EvmHead | null = null;
  try {
    const block = (await rpc("eth_getBlockByNumber", ["finalized", false])) as { number?: unknown } | null;
    const number = quantity(block?.number);
    if (number !== null) head = { block: number, mode: "finalized" };
  } catch {
    head = null;
  }
  if (!head) {
    const depth = confirmationsFallback(network);
    if (depth !== null) {
      try {
        const latest = quantity(await rpc("eth_blockNumber", []));
        if (latest !== null && latest >= BigInt(depth)) head = { block: latest - BigInt(depth), mode: `depth:${depth}` };
      } catch {
        head = null;
      }
    }
  }
  if (head && !injected) evmHeads.set(network, { value: head, at: now });
  return head;
}

async function solanaFinalizedSlot(network: NetworkKey, rpc: RpcTransport, now: number, injected: boolean): Promise<bigint | null> {
  const cached = injected ? undefined : solanaHeads.get(network);
  if (cached && now - cached.at < HEAD_TTL_MS) return cached.value;
  try {
    const slot = await rpc("getSlot", [{ commitment: "finalized" }]);
    const value = typeof slot === "number" && Number.isSafeInteger(slot) && slot >= 0 ? BigInt(slot) : null;
    if (value !== null && !injected) solanaHeads.set(network, { value, at: now });
    return value;
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------- planning */

interface PlannedAnchor {
  readonly step: IntentStep;
  readonly network: NetworkKey;
  readonly reference: string;
  readonly role: AnchorRole;
  readonly watch: readonly string[];
}

function chainAddress(account: string | undefined, chain: CaipChainId): string | null {
  const parsed = account ? parseAccountId(account) : null;
  if (!parsed || parsed.chain.id !== chain) return null;
  return parsed.chain.namespace === "eip155" ? parsed.address.toLowerCase() : parsed.address;
}

/** Step parties on one chain: the account, the recipient and, on a bridge's destination, the user's own account there. */
function watchOn(graph: IntentGraph, step: IntentStep, network: NetworkKey): string[] {
  const chain = CHAINS[network].id;
  const parties: string[] = [step.account, ...(step.recipient ? [step.recipient] : [])];
  if (network === step.settlement?.destinationNetwork) parties.push(...graph.request.accounts);
  const out = new Set<string>();
  for (const party of parties) {
    const address = chainAddress(party, chain);
    if (address) out.add(address);
  }
  return [...out].sort();
}

function validReference(network: NetworkKey, reference: string): boolean {
  return CHAINS[network].vm === "evm" ? EVM_HASH.test(reference) : isSolanaSignature(reference);
}

/** Which references become anchors (design §4.4). */
export function plannedAnchors(graph: IntentGraph): PlannedAnchor[] {
  const out: PlannedAnchor[] = [];
  for (const step of graph.steps) {
    for (const reference of step.references ?? []) {
      if (!validReference(step.network, reference)) continue;
      out.push({ step, network: step.network, reference, role: "origin", watch: watchOn(graph, step, step.network) });
    }
    const destination = step.settlement?.kind === "cross-network" ? step.settlement.destinationNetwork : undefined;
    if (!destination || (step.references ?? []).length === 0) continue;
    const seen = new Set<string>();
    for (const entry of step.evidence) {
      if (entry.kind !== "settlement" || entry.network !== destination || !entry.reference || !validReference(destination, entry.reference)) continue;
      const key = CHAINS[destination].vm === "evm" ? entry.reference.toLowerCase() : entry.reference;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ step, network: destination, reference: entry.reference, role: "fill", watch: watchOn(graph, step, destination) });
    }
  }
  return out;
}

/* ---------------------------------------------------------------- reading */

type AnchorOutcome =
  | { readonly kind: "ready"; readonly anchor: ReceiptAnchor }
  | { readonly kind: "waiting"; readonly expectedBy: number; readonly detail: string }
  | { readonly kind: "retry"; readonly detail: string }
  | { readonly kind: "reorged"; readonly detail: string };

function unavailable(error: unknown, planned: PlannedAnchor): AnchorOutcome {
  const reason = isAnchorUnavailable(error) ? `${error.reason}: ${error.message}` : error instanceof Error ? error.message : String(error);
  return { kind: "retry", detail: `${planned.step.id} ${planned.role} ${planned.reference.slice(0, 18)}…: ${reason}`.slice(0, 300) };
}

async function readEvm(
  planned: PlannedAnchor,
  rpc: RpcTransport,
  /** Unmemoised: the re-read after the head must reach the source again. */
  fresh: RpcTransport,
  head: EvmHead,
  now: number,
): Promise<AnchorOutcome> {
  let anchor: EvmAnchor;
  try {
    anchor = await readEvmAnchor(rpc, { chain: CHAINS[planned.network].id, tx: planned.reference, role: planned.role, watch: planned.watch });
  } catch (error) {
    return unavailable(error, planned);
  }
  const number = BigInt(anchor.blockNumber);
  if (number > head.block) {
    const expectedBy = (anchor.blockTimestamp + finalityLag(planned.network)) * 1000;
    return { kind: "waiting", expectedBy: Math.max(expectedBy, now + 15_000), detail: `${planned.step.id}: block ${anchor.blockNumber} is above the finalized head ${head.block}` };
  }
  // Re-read the block at that height after the head: another hash now means a reorg.
  try {
    const block = (await fresh("eth_getBlockByNumber", [`0x${number.toString(16)}`, false])) as { hash?: unknown } | null;
    const hash = typeof block?.hash === "string" ? block.hash.toLowerCase() : null;
    if (hash === null) return { kind: "retry", detail: `${planned.step.id}: block ${anchor.blockNumber} is unreadable` };
    if (hash !== anchor.blockHash) return { kind: "reorged", detail: `${planned.step.id}: block ${anchor.blockNumber} now has hash ${hash}, not ${anchor.blockHash}` };
  } catch (error) {
    return unavailable(error, planned);
  }
  return { kind: "ready", anchor };
}

async function readSvm(planned: PlannedAnchor, rpc: RpcTransport, fresh: RpcTransport, now: number): Promise<AnchorOutcome> {
  let status: { confirmationStatus?: unknown; slot?: unknown } | null = null;
  try {
    const statuses = (await rpc("getSignatureStatuses", [[planned.reference], { searchTransactionHistory: true }])) as { value?: unknown } | null;
    const value = Array.isArray(statuses?.value) ? statuses.value[0] : null;
    status = value && typeof value === "object" ? (value as { confirmationStatus?: unknown; slot?: unknown }) : null;
  } catch (error) {
    return unavailable(error, planned);
  }
  if (!status) return { kind: "retry", detail: `${planned.step.id}: signature ${planned.reference.slice(0, 12)}… is unknown to this source` };
  if (status.confirmationStatus !== "finalized") {
    return { kind: "waiting", expectedBy: now + finalityLag(planned.network) * 1000, detail: `${planned.step.id}: signature is ${String(status.confirmationStatus)}` };
  }
  let anchor: SvmAnchor;
  try {
    anchor = await readSvmAnchor(rpc, { chain: CHAINS[planned.network].id, signature: planned.reference, role: planned.role, watch: planned.watch });
  } catch (error) {
    return unavailable(error, planned);
  }
  try {
    const block = (await fresh("getBlock", [
      Number(anchor.slot),
      { commitment: "finalized", transactionDetails: "none", rewards: false, maxSupportedTransactionVersion: RECEIPT_SOLANA_MAX_TRANSACTION_VERSION },
    ])) as { blockhash?: unknown } | null;
    if (typeof block?.blockhash !== "string") return { kind: "retry", detail: `${planned.step.id}: finalized block ${anchor.slot} is unreadable` };
    if (block.blockhash !== anchor.blockhash) return { kind: "reorged", detail: `${planned.step.id}: slot ${anchor.slot} now has blockhash ${block.blockhash}` };
  } catch (error) {
    return unavailable(error, planned);
  }
  return { kind: "ready", anchor };
}

/** The binding the step's landed EVM origin transactions reproduce, when it is one of its prepared bindings. */
async function landedBinding(step: IntentStep, anchors: readonly ReceiptAnchor[], rpc: RpcTransport | null): Promise<string | null> {
  const origins = anchors.filter((anchor): anchor is EvmAnchor => anchor.vm === "evm" && anchor.role === "origin");
  if (!rpc || origins.length === 0 || origins.length !== (step.references ?? []).length) return null;
  const prepared = new Set(
    step.evidence
      .filter((entry) => entry.kind === "quote" && typeof entry.reference === "string" && RECEIPT_DIGEST_PATTERN.test(entry.reference))
      .map((entry) => entry.reference as string),
  );
  if (step.prepared) prepared.add(step.prepared.quoteBinding);
  if (prepared.size === 0) return null;
  try {
    const views = await Promise.all(origins.map((anchor) => readEvmBindingView(rpc, { chain: anchor.chain, tx: anchor.tx })));
    const binding = quoteBindingForViews(views.map((view) => evmBindingView(view)));
    return prepared.has(binding) ? binding : null;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- collect */

/**
 * Reads every anchor of a finished intent and decides whether a receipt can
 * be issued now (`ready`), later (`waiting_finality`, with `expectedBy`),
 * after a retry (`retry`: unreadable or inconsistent sources) or only after
 * the intent is refreshed (`reorged`). Never throws for RPC trouble.
 */
export async function collectReceiptInputs(graph: IntentGraph, options: CollectReceiptOptions = {}): Promise<ReceiptCollection> {
  const now = options.now ?? Date.now();
  const empty = { anchors: {}, landedBindings: {}, finalityHeads: [], finalityMode: [], expectedBy: null } as const;
  if (!isReceiptableStatus(graph.status)) return { state: "retry", ...empty, detail: `Intents in status ${graph.status} get no receipt.` };
  const planned = plannedAnchors(graph);
  if (graph.status === "cancelled" || planned.length === 0) {
    // Nothing reached a chain: a receipt without anchors (cancelled, or failed before any reference landed).
    return { state: "ready", ...empty };
  }
  const memo = new Map<string, Promise<unknown>>();
  const transports = new Map<NetworkKey, { readonly memo: RpcTransport; readonly fresh: RpcTransport }>();
  const pair = (network: NetworkKey) => {
    if (!transports.has(network)) {
      try {
        const base = baseTransport(network, options);
        transports.set(network, { memo: memoised(network, base, memo), fresh: base });
      } catch {
        return null;
      }
    }
    return transports.get(network) ?? null;
  };
  const transport = (network: NetworkKey): RpcTransport | null => pair(network)?.memo ?? null;
  const networks = [...new Set(planned.map((entry) => entry.network))];
  const heads = new Map<NetworkKey, EvmHead | bigint | null>();
  // Finality heads first: a block hash re-read after the head proves the anchor sits under it.
  await Promise.all(networks.map(async (network) => {
    const rpc = transport(network);
    const injected = options.transports?.[network] !== undefined;
    if (!rpc) heads.set(network, null);
    else if (CHAINS[network].vm === "evm") heads.set(network, await evmFinalizedHead(network, rpc, now, injected));
    else heads.set(network, await solanaFinalizedSlot(network, rpc, now, injected));
  }));
  const outcomes = await Promise.all(planned.map(async (entry): Promise<AnchorOutcome> => {
    const rpc = pair(entry.network);
    const head = heads.get(entry.network);
    if (!rpc || head === null || head === undefined) return { kind: "retry", detail: `${CHAINS[entry.network].name}: no finalized head (the RPC serves no "finalized" tag and no confirmation depth is configured).` };
    return CHAINS[entry.network].vm === "evm" ? readEvm(entry, rpc.memo, rpc.fresh, head as EvmHead, now) : readSvm(entry, rpc.memo, rpc.fresh, now);
  }));

  const reorged = outcomes.find((outcome) => outcome.kind === "reorged");
  const retry = outcomes.find((outcome) => outcome.kind === "retry");
  const waiting = outcomes.filter((outcome): outcome is Extract<AnchorOutcome, { kind: "waiting" }> => outcome.kind === "waiting");
  const anchors: Record<string, ReceiptAnchor[]> = {};
  planned.forEach((entry, index) => {
    const outcome = outcomes[index];
    if (outcome?.kind !== "ready") return;
    (anchors[entry.step.id] ??= []).push(outcome.anchor);
  });
  // Origins first (reference order), then fills.
  for (const list of Object.values(anchors)) list.sort((a, b) => (a.role === b.role ? 0 : a.role === "origin" ? -1 : 1));
  const finalityHeads: ReceiptFinalityHead[] = [];
  const finalityMode: ReceiptFinalityMode[] = [];
  for (const network of networks) {
    const head = heads.get(network);
    const chain = CHAINS[network].id;
    if (head === null || head === undefined) continue;
    if (typeof head === "bigint") {
      finalityHeads.push({ chain, slot: head.toString() });
      finalityMode.push({ chain, mode: "finalized" });
    } else {
      finalityHeads.push({ chain, block: head.block.toString() });
      finalityMode.push({ chain, mode: head.mode });
    }
  }
  if (reorged) return { state: "reorged", ...empty, finalityHeads, finalityMode, detail: reorged.detail };
  if (retry) return { state: "retry", ...empty, finalityHeads, finalityMode, detail: retry.detail };
  if (waiting.length > 0) {
    const expectedBy = Math.max(...waiting.map((entry) => entry.expectedBy));
    return {
      state: "waiting_finality",
      anchors,
      landedBindings: {},
      finalityHeads,
      finalityMode,
      expectedBy: new Date(expectedBy).toISOString(),
      detail: waiting.map((entry) => entry.detail).join("; ").slice(0, 300),
    };
  }
  const landedBindings: Record<string, string | null> = {};
  await Promise.all(graph.steps.map(async (step) => {
    landedBindings[step.id] = CHAINS[step.network].vm === "evm" ? await landedBinding(step, anchors[step.id] ?? [], transport(step.network)) : null;
  }));
  return { state: "ready", anchors, landedBindings, finalityHeads, finalityMode, expectedBy: null };
}

export { AnchorUnavailableError };
