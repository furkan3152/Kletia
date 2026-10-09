/**
 * Receipt inputs (receipts design R2): anchors read through the core readers
 * from fake transports holding the read-only responses captured live for the
 * receipt vectors (a Base transaction and a version 1 Solana transaction),
 * finality gating (finalized head, block-hash re-check after it, Solana
 * finalized status), reorg / retry / waiting signals, the confirmation-depth
 * fallback, landed EVM bindings and their parity with the engine's binding.
 */
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  buildPlanRecord,
  buildReceipt,
  CHAINS,
  evmBindingView,
  evmQuoteBinding,
  planRecordDigest,
  randomReceiptSalt,
  receiptDigest,
  receiptKeyId,
  receiptSigningInput,
  RECEIPT_EVENT_TYPE,
  verifyReceipt,
  type EvidenceGroup,
  type IntentGraph,
  type IntentStep,
  type NetworkKey,
  type ReceiptKey,
  type RpcTransport,
} from "@kletia/core";
import { quoteBindingForViews } from "../binding.js";
import { platformEvents, publishReceiptEvent, subscribeReceiptEvents } from "../events.js";
import { collectReceiptInputs, RECEIPT_FINALITY_LAG_SECONDS, resetReceiptHeads } from "../receipts/collect.js";

interface Fixtures {
  readonly evm: { eth_getTransactionByHash: Record<string, unknown>; eth_getTransactionReceipt: Record<string, unknown>; eth_getBlockByNumber: Record<string, unknown> };
  readonly svm: { getTransaction: Record<string, unknown>; getBlock: { blockhash: string } };
}
const fixtures = JSON.parse(readFileSync(new URL("./receiptAnchorFixtures.json", import.meta.url), "utf8")) as Fixtures;

const TX = String(fixtures.evm.eth_getTransactionByHash.hash);
const FROM = String(fixtures.evm.eth_getTransactionByHash.from);
const TO = String(fixtures.evm.eth_getTransactionByHash.to);
const BLOCK = BigInt(String(fixtures.evm.eth_getTransactionReceipt.blockNumber));
const BLOCK_HASH = String(fixtures.evm.eth_getTransactionReceipt.blockHash);
const BLOCK_TIME = Number(BigInt(String(fixtures.evm.eth_getBlockByNumber.timestamp)));
const SIGNATURE = (fixtures.svm.getTransaction.transaction as { signatures: string[] }).signatures[0] as string;
const SLOT = Number(fixtures.svm.getTransaction.slot);
const SOL_KEYS = (fixtures.svm.getTransaction.transaction as { message: { accountKeys: string[] } }).message.accountKeys;
const hex = (value: bigint) => `0x${value.toString(16)}`;

/** The engine binding of the landed Base transaction (what prepare would have recorded). */
const VIEW = evmBindingView({
  chainId: 8453,
  from: FROM,
  to: TO,
  data: String(fixtures.evm.eth_getTransactionByHash.input),
  value: BigInt(String(fixtures.evm.eth_getTransactionByHash.value)),
});
const BINDING = quoteBindingForViews([VIEW]);

interface EvmChainState {
  finalized: bigint | "unsupported";
  latest: bigint;
  /** Hash the block at BLOCK reports on the n-th read (reorg after the first read). */
  hashes: string[];
  receipt: Record<string, unknown> | null;
  status: string;
  readonly calls: { method: string; params: readonly unknown[] }[];
}

let evm: EvmChainState;
let solana: { confirmation: string | null; blockhash: string; finalizedSlot: number; readonly calls: { method: string; params: readonly unknown[] }[] };

beforeEach(() => {
  resetReceiptHeads();
  evm = { finalized: BLOCK + 100n, latest: BLOCK + 500n, hashes: [BLOCK_HASH], receipt: fixtures.evm.eth_getTransactionReceipt, status: "0x1", calls: [] };
  solana = { confirmation: "finalized", blockhash: fixtures.svm.getBlock.blockhash, finalizedSlot: SLOT + 31, calls: [] };
});

afterEach(() => {
  delete process.env.KLETIA_RECEIPT_CONFIRMATIONS_BASE;
});

const evmTransport: RpcTransport = async (method, params) => {
  evm.calls.push({ method, params });
  switch (method) {
    case "eth_getTransactionByHash":
      return String(params[0]).toLowerCase() === TX.toLowerCase() ? fixtures.evm.eth_getTransactionByHash : null;
    case "eth_getTransactionReceipt":
      return evm.receipt && String(params[0]).toLowerCase() === TX.toLowerCase() ? { ...evm.receipt, status: evm.status } : null;
    case "eth_getBlockByNumber": {
      if (params[0] === "finalized") {
        if (evm.finalized === "unsupported") throw Object.assign(new Error("invalid block tag"), { code: -32602 });
        return { ...fixtures.evm.eth_getBlockByNumber, number: hex(evm.finalized), hash: `0x${"ef".repeat(32)}` };
      }
      const reads = evm.calls.filter((call) => call.method === "eth_getBlockByNumber" && call.params[0] === hex(BLOCK)).length;
      const hash = evm.hashes[Math.min(reads - 1, evm.hashes.length - 1)];
      return BigInt(String(params[0])) === BLOCK ? { ...fixtures.evm.eth_getBlockByNumber, hash } : null;
    }
    case "eth_blockNumber":
      return hex(evm.latest);
    default:
      throw new Error(`unexpected ${method}`);
  }
};

const solanaTransport: RpcTransport = async (method, params) => {
  solana.calls.push({ method, params });
  switch (method) {
    case "getSlot":
      return solana.finalizedSlot;
    case "getSignatureStatuses":
      return { context: { slot: SLOT + 40 }, value: [solana.confirmation === null ? null : { slot: SLOT, confirmations: null, err: null, confirmationStatus: solana.confirmation }] };
    case "getTransaction":
      return params[0] === SIGNATURE ? fixtures.svm.getTransaction : null;
    case "getBlock": {
      // The reader sees the block as landed; a later read (the re-check) may see another hash.
      const reads = solana.calls.filter((call) => call.method === "getBlock").length;
      return { blockhash: reads === 1 ? fixtures.svm.getBlock.blockhash : solana.blockhash };
    }
    default:
      throw new Error(`unexpected ${method}`);
  }
};

const transports: Partial<Record<NetworkKey, RpcTransport>> = { base: evmTransport, solana: solanaTransport };

function step(overrides: Partial<IntentStep> = {}): IntentStep {
  return {
    id: "s1",
    index: 0,
    kind: "transfer",
    title: "Send USDC",
    network: "base",
    chain: CHAINS.base.id,
    account: `eip155:8453:${FROM}`,
    recipient: `eip155:8453:${TO}`,
    protocol: "erc20-transfer",
    mode: "wallet",
    dependsOn: [],
    status: "settled",
    references: [TX],
    evidence: [
      { kind: "quote", network: "base", reference: BINDING, observedAt: "2026-10-09T12:00:00.000Z", detail: "Prepared 1 transaction(s)." },
      { kind: "note", network: "base", reference: TX, observedAt: "2026-10-09T12:00:30.000Z", detail: "References submitted." },
    ],
    prepared: { quoteBinding: BINDING, preparedAt: "2026-10-09T12:00:00.000Z", expiresAt: 1_791_550_000, transactions: [{ vm: "evm", network: "base", to: TO, description: "send" }] },
    ...overrides,
  };
}

function graph(steps: readonly IntentStep[], status: IntentGraph["status"] = "completed"): IntentGraph {
  return {
    spec: "kletia.intent/v1",
    id: "int_0123456789abcdef0123456789abcdef",
    createdAt: "2026-10-09T11:59:00.000Z",
    updatedAt: "2026-10-09T12:20:00.000Z",
    expiresAt: "2026-10-09T12:29:00.000Z",
    status,
    request: { accounts: [`eip155:8453:${FROM}`, `${CHAINS.solana.id}:${SOL_KEYS[0]}`] } as IntentGraph["request"],
    interpretation: { source: "structured", confidence: 1 },
    steps,
    edges: [],
    summary: { title: "test", networks: ["base"], inputs: [], outputs: [], signaturesRequired: 1, crossNetwork: false },
    warnings: [],
  };
}

const now = (BLOCK_TIME + 5_000) * 1000;

describe("receipt inputs", () => {
  it("reads a finalized EVM anchor, re-checks its block hash and reproduces the landed binding", async () => {
    const collection = await collectReceiptInputs(graph([step()]), { transports, now });
    assert.equal(collection.state, "ready", collection.detail);
    const anchor = collection.anchors.s1?.[0];
    assert.equal(anchor?.vm, "evm");
    if (anchor?.vm !== "evm") return;
    assert.deepEqual([anchor.role, anchor.tx, anchor.blockNumber, anchor.blockHash, anchor.status], ["origin", TX.toLowerCase(), BLOCK.toString(), BLOCK_HASH, "success"]);
    assert.deepEqual(anchor.watch, [FROM.toLowerCase(), TO.toLowerCase()].sort());
    assert.equal(anchor.transfers.length, 2, "both USDC legs touching the watched recipient");
    assert.equal(collection.landedBindings.s1, BINDING);
    assert.deepEqual(collection.finalityHeads, [{ chain: "eip155:8453", block: (BLOCK + 100n).toString() }]);
    assert.deepEqual(collection.finalityMode, [{ chain: "eip155:8453", mode: "finalized" }]);
    // The block is read twice: by the reader and again after the finalized head (unmemoised).
    assert.equal(evm.calls.filter((call) => call.method === "eth_getBlockByNumber" && call.params[0] === hex(BLOCK)).length, 2);
  });

  it("matches the engine's quote binding with core's (parity)", async () => {
    assert.equal(await evmQuoteBinding([VIEW]), BINDING);
  });

  it("waits for finality with an expectedBy from the measured lag", async () => {
    evm.finalized = BLOCK - 1n;
    const collection = await collectReceiptInputs(graph([step()]), { transports, now: BLOCK_TIME * 1000 });
    assert.equal(collection.state, "waiting_finality");
    assert.equal(collection.expectedBy, new Date((BLOCK_TIME + RECEIPT_FINALITY_LAG_SECONDS.base) * 1000).toISOString());
    assert.deepEqual(collection.landedBindings, {});
  });

  it("reports a reorg when the block at the anchor's height changed hash after the head", async () => {
    evm.hashes = [BLOCK_HASH, `0x${"99".repeat(32)}`];
    const collection = await collectReceiptInputs(graph([step()]), { transports, now });
    assert.equal(collection.state, "reorged");
    assert.match(collection.detail ?? "", /now has hash 0x9999/u);
    assert.deepEqual(collection.anchors, {});
  });

  it("asks for a retry when a source cannot show the transaction (never 'does not exist')", async () => {
    evm.receipt = null;
    const collection = await collectReceiptInputs(graph([step()]), { transports, now });
    assert.equal(collection.state, "retry");
    assert.match(collection.detail ?? "", /not_found/u);
  });

  it("anchors a reverted origin as reverted", async () => {
    evm.status = "0x0";
    const collection = await collectReceiptInputs(graph([step({ status: "failed", failure: { code: "TRANSACTION_REVERTED", message: "reverted" } })], "failed"), { transports, now });
    assert.equal(collection.state, "ready");
    const anchor = collection.anchors.s1?.[0];
    assert.equal(anchor?.vm === "evm" ? anchor.status : null, "reverted");
  });

  it("reads a Relay-style fill on Solana from a version 1 transaction (maxSupportedTransactionVersion 1)", async () => {
    const bridge = step({
      kind: "bridge",
      protocol: "relay",
      recipient: `${CHAINS.solana.id}:${SOL_KEYS[0]}`,
      settlement: { kind: "cross-network", destinationNetwork: "solana", trackingId: `0x${"12".repeat(32)}` },
      evidence: [
        ...step().evidence,
        { kind: "settlement", network: "solana", reference: SIGNATURE, observedAt: "2026-10-09T12:05:00.000Z", detail: "Relay fill observed." },
        { kind: "settlement", network: "solana", reference: "not-a-signature", observedAt: "2026-10-09T12:05:00.000Z", detail: "provider id" },
      ],
    });
    const collection = await collectReceiptInputs(graph([bridge]), { transports, now });
    assert.equal(collection.state, "ready", collection.detail);
    const anchors = collection.anchors.s1 ?? [];
    assert.deepEqual(anchors.map((anchor) => `${anchor.vm}:${anchor.role}`), ["evm:origin", "svm:fill"]);
    const fill = anchors[1];
    assert.equal(fill?.vm === "svm" ? fill.version : null, "1");
    assert.equal(fill?.vm === "svm" ? fill.blockhash : null, fixtures.svm.getBlock.blockhash);
    const request = solana.calls.find((call) => call.method === "getTransaction");
    assert.equal((request?.params[1] as { maxSupportedTransactionVersion?: number }).maxSupportedTransactionVersion, 1);
    assert.deepEqual(collection.finalityHeads, [{ chain: "eip155:8453", block: (BLOCK + 100n).toString() }, { chain: CHAINS.solana.id, slot: String(SLOT + 31) }]);
  });

  it("waits while a Solana fill is only confirmed, and reports a moved Solana block", async () => {
    const bridge = step({
      kind: "bridge",
      settlement: { kind: "cross-network", destinationNetwork: "solana" },
      evidence: [...step().evidence, { kind: "settlement", network: "solana", reference: SIGNATURE, observedAt: "2026-10-09T12:05:00.000Z", detail: "fill" }],
    });
    solana.confirmation = "confirmed";
    assert.equal((await collectReceiptInputs(graph([bridge]), { transports, now })).state, "waiting_finality");
    solana.confirmation = "finalized";
    solana.calls.length = 0;
    solana.blockhash = "11111111111111111111111111111111";
    const moved = await collectReceiptInputs(graph([bridge]), { transports, now });
    assert.equal(moved.state, "reorged");
    assert.match(moved.detail ?? "", /now has blockhash 1111/u);
  });

  it("falls back to a configured confirmation depth where the finalized tag is not served", async () => {
    evm.finalized = "unsupported";
    const without = await collectReceiptInputs(graph([step()]), { transports, now });
    assert.equal(without.state, "retry");
    assert.match(without.detail ?? "", /no finalized head/u);
    process.env.KLETIA_RECEIPT_CONFIRMATIONS_BASE = "64";
    const depth = await collectReceiptInputs(graph([step()]), { transports, now });
    assert.equal(depth.state, "ready", depth.detail);
    assert.deepEqual(depth.finalityMode, [{ chain: "eip155:8453", mode: "depth:64" }]);
    assert.deepEqual(depth.finalityHeads, [{ chain: "eip155:8453", block: (BLOCK + 500n - 64n).toString() }]);
  });

  it("issues cancelled intents without anchors and refuses statuses that get no receipt", async () => {
    const cancelled = await collectReceiptInputs(graph([step({ status: "skipped", references: [] })], "cancelled"), { transports, now });
    assert.deepEqual([cancelled.state, cancelled.anchors, cancelled.finalityHeads], ["ready", {}, []]);
    const executing = await collectReceiptInputs(graph([step({ status: "submitted" })], "executing"), { transports, now });
    assert.equal(executing.state, "retry");
    assert.equal(evm.calls.length, 0, "nothing is read for either");
  });

  it("leaves the binding null when the landed transactions match no prepared payload", async () => {
    const other = step({ evidence: [], prepared: { quoteBinding: "ab".repeat(32), preparedAt: "2026-10-09T12:00:00.000Z", expiresAt: 0, transactions: [] } });
    const collection = await collectReceiptInputs(graph([other]), { transports, now });
    assert.equal(collection.state, "ready");
    assert.equal(collection.landedBindings.s1, null);
  });
});

describe("receipt inputs feed the core builder (R2 → R3 contract)", () => {
  it("builds, signs with a development key and verifies a receipt from collected inputs", async () => {
    const base = graph([step()]);
    const record = buildPlanRecord(base);
    const intent: IntentGraph = { ...base, plan: { digest: planRecordDigest(record), record } };
    const collection = await collectReceiptInputs(intent, { transports, now });
    assert.equal(collection.state, "ready");
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const x = String(publicKey.export({ format: "jwk" }).x);
    const kid = receiptKeyId(x);
    const built = buildReceipt({
      graph: intent,
      collection,
      receiptId: "rcpt_0123456789abcdef0123456789abcdef",
      sequence: 1,
      supersedes: null,
      issuedAt: "2026-10-09T13:00:00.000Z",
      issuer: { name: "Kletia", origin: "https://api.kletiaai.xyz", apiVersion: "1.0.0", kid },
      salts: () => randomReceiptSalt(),
    });
    const digest = await receiptDigest(built.payload);
    const signature = sign(null, Buffer.from(receiptSigningInput(digest), "utf8"), privateKey).toString("base64url");
    const key: ReceiptKey = { kty: "OKP", crv: "Ed25519", x, kid, alg: "Ed25519", use: "sig", status: "development", notBefore: "2026-01-01" };
    const document = { payload: built.payload, digest, signature: { alg: "Ed25519" as const, kid, value: signature }, disclosures: built.disclosures };
    const verification = await verifyReceipt(document, { keys: [key], intentId: intent.id, requireGroups: ["steps.*.evidence"] });
    assert.equal(verification.valid, true, JSON.stringify(verification.problems));
    assert.equal(verification.intentMatches, true);
    const evidence = built.disclosures["steps.s1.evidence"]?.value as EvidenceGroup;
    assert.equal(evidence.landedBinding, BINDING);
    assert.equal(evidence.anchors.length, 1);
  });

  it("publishes intent.receipt_issued to the typed bus and receipt subscribers", () => {
    const seen: string[] = [];
    const unsubscribe = subscribeReceiptEvents((event) => seen.push(`${event.type}:${event.data.receiptId}`));
    const unbus = platformEvents.on(RECEIPT_EVENT_TYPE, (data) => seen.push(`bus:${data.sequence}`));
    const event = publishReceiptEvent({
      intentId: "int_0123456789abcdef0123456789abcdef",
      receiptId: "rcpt_0123456789abcdef0123456789abcdef",
      sequence: 1,
      status: "completed",
      terminal: true,
      digest: "ab".repeat(32),
      kid: "kid",
      supersedes: null,
    });
    unsubscribe();
    unbus();
    assert.equal(event.type, "intent.receipt_issued");
    assert.deepEqual(seen.sort(), ["bus:1", "intent.receipt_issued:rcpt_0123456789abcdef0123456789abcdef"]);
  });
});
