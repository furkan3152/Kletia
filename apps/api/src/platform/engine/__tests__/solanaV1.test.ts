/**
 * Solana version 1 transactions (receipts design F0). Version 1 is live and
 * common on mainnet; an RPC refuses (`-32015`) to return a v1 body to a
 * client that asks for version 0, so every landed-transaction reader must ask
 * for version 1, and unsigned-payload inspection must decode v1 messages
 * (config header instead of ComputeBudget instructions, no lookup tables).
 * Fixtures are two finalized mainnet v1 transactions recorded live
 * (`solanaV1Fixtures.json`): a USDC credit and a lamport credit.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  address,
  appendTransactionMessageInstruction,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  getBase58Encoder,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getTransactionDecoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageConfig,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { PlatformError } from "../../errors.js";
import { SOLANA_MAX_SUPPORTED_TRANSACTION_VERSION, verifySolanaTransaction } from "../../../networks/solana/index.js";
import { destinationCredit } from "../adapters/relay.js";
import { debridgeDlnAdapter, resetDlnFixFeeCache } from "../adapters/debridge.js";
import type { SettlementResult } from "../adapters/types.js";
import {
  assertSolanaTransactionOwner,
  decodeSolanaTransaction,
  inspectUnsignedSolanaTransaction,
  MAX_V1_PRIORITY_FEE_LAMPORTS,
  observeSolanaTransaction,
  readSolanaCredit,
  SOLANA_PROGRAM_IDS,
  SOLANA_VERSION_UNREADABLE,
} from "../chains/solana.js";
import {
  asset,
  bridgeAction,
  createdOrderLog,
  dlnEventOrder,
  dlnEvmCall,
  dlnOrderBody,
  dlnStateInfo,
  DLN_SOLANA_STATE,
  evmBridgeStep,
  installCrossChainMock,
  landPrepared,
  PREPARED_AT,
  type CrossChainMock,
} from "./crosschainFixtures.js";
import { randomEvmHash } from "./helpers.js";

interface V1Fixture {
  readonly signature: string;
  readonly getSignatureStatuses: unknown;
  readonly getTransactionV0Error: { readonly code: number; readonly message: string };
  readonly getTransactionJson: {
    readonly slot: number;
    readonly blockTime: number;
    readonly version: number;
    readonly meta: { readonly fee: number };
    readonly transaction: {
      readonly message: {
        readonly accountKeys: readonly string[];
        readonly header: { readonly numRequiredSignatures: number; readonly numReadonlySignedAccounts: number; readonly numReadonlyUnsignedAccounts: number };
        readonly instructions: readonly { readonly programIdIndex: number; readonly accounts: readonly number[]; readonly data: string }[];
        readonly transactionConfig: { readonly computeUnitLimit: number | null; readonly heapSize: number | null; readonly loadedAccountsDataSizeLimit: number | null; readonly priorityFee: number | null };
      };
    };
  };
  readonly wireBase64: string;
}

const fixtures = JSON.parse(readFileSync(new URL("./solanaV1Fixtures.json", import.meta.url), "utf8")) as {
  readonly transactions: { readonly usdcCredit: V1Fixture; readonly lamportCredit: V1Fixture };
};
const USDC_FILL = fixtures.transactions.usdcCredit;
const SOL_FILL = fixtures.transactions.lamportCredit;
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/** Credited 233,883 USDC units by USDC_FILL. */
const USDC_RECIPIENT = "8FnX3xo2yYw3EUE6w3nQA4GfXGS9wpK6oj3veJpbFzLo";
const USDC_FILL_PAYER = "CHjFz2RsyAMeEKBgdKvPxMFVN7A86h5MsgqEkoPEkNQ1";
/** Credited 144,312,640 lamports by SOL_FILL. */
const SOL_RECIPIENT = "8P78tevLaqeRFKjD6qvomp465NXCCjj9ZsL4jKGcrWny";
const SOL_FILL_PAYER = "2Q8qvpP46xKjScRKGtF1JaBT2VVcA62VCSnU2bF3ktjd";
const FIXTURES = new Map([USDC_FILL, SOL_FILL].map((fixture) => [fixture.signature, fixture]));

interface RpcRequest {
  readonly id: unknown;
  readonly method: string;
  readonly params?: unknown[];
}

interface V1Rpc {
  readonly requests: RpcRequest[];
  /** Simulates a future version: every getTransaction is refused with -32015, whatever version is asked for. */
  refuseEveryVersion: boolean;
  /** Requests nobody answered (strict mode: never sent to the network). */
  readonly unknown: string[];
  restore(): void;
}

/**
 * Answers getSignatureStatuses / getTransaction for the fixture signatures
 * like a live RPC (a v1 body only to a request naming version 1 or newer).
 * Every other request goes to the fetch mock installed before it, or, when
 * `strict`, is refused and recorded (never sent to the network).
 */
function installV1Rpc(strict: boolean): V1Rpc {
  const previous = globalThis.fetch;
  const rpc: V1Rpc = {
    requests: [],
    refuseEveryVersion: false,
    unknown: [],
    restore: () => {
      globalThis.fetch = previous;
    },
  };
  const answer = (request: RpcRequest): unknown | undefined => {
    const params = request.params ?? [];
    if (request.method === "getSignatureStatuses") {
      const signatures = params[0] as string[];
      if (!signatures.every((signature) => FIXTURES.has(signature))) return undefined;
      rpc.requests.push(request);
      const statuses = signatures.map((signature) => (FIXTURES.get(signature)?.getSignatureStatuses as { value: unknown[] }).value[0]);
      return { jsonrpc: "2.0", id: request.id, result: { context: { slot: 454_905_500 }, value: statuses } };
    }
    if (request.method === "getTransaction") {
      const fixture = FIXTURES.get(String(params[0]));
      if (!fixture) return undefined;
      rpc.requests.push(request);
      const config = (params[1] ?? {}) as { maxSupportedTransactionVersion?: unknown };
      if (rpc.refuseEveryVersion) {
        return {
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32015, message: "Transaction version (2) is not supported by the requesting client. Please try the request again with the following configuration parameter: \"maxSupportedTransactionVersion\": 2" },
        };
      }
      if (typeof config.maxSupportedTransactionVersion !== "number" || config.maxSupportedTransactionVersion < fixture.getTransactionJson.version) {
        return { jsonrpc: "2.0", id: request.id, error: fixture.getTransactionV0Error };
      }
      return { jsonrpc: "2.0", id: request.id, result: fixture.getTransactionJson };
    }
    return undefined;
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    let payload: unknown;
    try {
      payload = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    } catch {
      payload = undefined;
    }
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const response = answer(payload as RpcRequest);
      if (response !== undefined) return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (strict) {
      rpc.unknown.push(`${String(input)} ${typeof init?.body === "string" ? init.body.slice(0, 80) : ""}`);
      return new Response(JSON.stringify({ message: "unmocked" }), { status: 500 });
    }
    return previous(input, init);
  }) as typeof fetch;
  return rpc;
}

let rpc: V1Rpc;

beforeEach(() => {
  rpc = installV1Rpc(true);
});

afterEach(() => {
  rpc.restore();
  assert.deepEqual(rpc.unknown, []);
});

function transactionRequests(): { maxSupportedTransactionVersion?: unknown }[] {
  return rpc.requests.filter((request) => request.method === "getTransaction").map((request) => (request.params?.[1] ?? {}) as { maxSupportedTransactionVersion?: unknown });
}

describe("landed version 1 transactions (live mainnet fixtures, 2026-10-09)", () => {
  it("were refused to a version 0 client (-32015), so every reader asks for version 1", async () => {
    assert.equal(USDC_FILL.getTransactionV0Error.code, -32015);
    assert.match(USDC_FILL.getTransactionV0Error.message, /Transaction version \(1\) is not supported/u);
    assert.equal(SOLANA_MAX_SUPPORTED_TRANSACTION_VERSION, 1);
    await observeSolanaTransaction("solana", USDC_FILL.signature, USDC_FILL_PAYER);
    await readSolanaCredit("solana", USDC_FILL.signature, USDC_RECIPIENT, USDC_MINT);
    await verifySolanaTransaction("solana", USDC_FILL.signature, USDC_FILL_PAYER);
    const requests = transactionRequests();
    assert.equal(requests.length, 3);
    for (const config of requests) assert.equal(config.maxSupportedTransactionVersion, 1);
  });

  it("observes a v1 body: fee payer, programs, resolved instructions, fee and balance deltas", async () => {
    const observation = await observeSolanaTransaction("solana", USDC_FILL.signature, USDC_FILL_PAYER);
    const message = USDC_FILL.getTransactionJson.transaction.message;
    assert.equal(observation.status, "finalized");
    assert.equal(observation.error, null);
    assert.equal(observation.detailsAvailable, true);
    assert.equal(observation.feePayer, USDC_FILL_PAYER);
    assert.equal(observation.slot, String(USDC_FILL.getTransactionJson.slot));
    assert.equal(observation.blockTime, USDC_FILL.getTransactionJson.blockTime);
    assert.equal(observation.fee, 20_316n);
    assert.deepEqual(observation.programs, [SOLANA_PROGRAM_IDS.system, SOLANA_PROGRAM_IDS.associatedToken, "DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH", SOLANA_PROGRAM_IDS.token]);
    assert.equal(observation.instructions?.length, message.instructions.length);
    message.instructions.forEach((instruction, index) => {
      const view = observation.instructions?.[index];
      assert.equal(view?.program, message.accountKeys[instruction.programIdIndex]);
      assert.deepEqual(view?.accounts, instruction.accounts.map((position) => message.accountKeys[position]));
      assert.deepEqual(view?.data, Uint8Array.from(getBase58Encoder().encode(instruction.data)));
    });
    assert.equal(observation.tokenDeltas.get(`${USDC_RECIPIENT}:${USDC_MINT}`), 233_883n);
    assert.equal(observation.tokenDeltas.get(`H57GKXxevvzknn1cpQA3gjD6t5okRVjJ2PpSXX6LQY3B:${USDC_MINT}`), -233_883n);
    assert.equal(observation.lamportDeltas.get(USDC_FILL_PAYER), 2_099_637n);
    assert.ok((observation.innerInstructions?.length ?? 0) > 0);
  });

  it("still refuses a v1 transaction fee-paid by someone else", async () => {
    const foreign = await observeSolanaTransaction("solana", USDC_FILL.signature, SOL_FILL_PAYER);
    assert.equal(foreign.status, "failed");
    assert.match(foreign.error ?? "", /fee payer does not match/u);
  });

  it("measures SPL and native credits of a v1 fill", async () => {
    assert.deepEqual(await readSolanaCredit("solana", USDC_FILL.signature, USDC_RECIPIENT, USDC_MINT), {
      status: "success",
      credited: 233_883n,
      blockTime: USDC_FILL.getTransactionJson.blockTime,
    });
    assert.deepEqual(await readSolanaCredit("solana", SOL_FILL.signature, SOL_RECIPIENT, null), {
      status: "success",
      credited: 144_312_640n,
      blockTime: SOL_FILL.getTransactionJson.blockTime,
    });
  });

  it("verifies the fee payer of a v1 transaction (Solana module)", async () => {
    const evidence = await verifySolanaTransaction("solana", SOL_FILL.signature, SOL_FILL_PAYER);
    assert.equal(evidence.status, "finalized");
    assert.equal(evidence.signer, SOL_FILL_PAYER);
    assert.equal(evidence.feeLamports, "11000");
    assert.equal(evidence.blockTime, SOL_FILL.getTransactionJson.blockTime);
    const foreign = await verifySolanaTransaction("solana", SOL_FILL.signature, USDC_FILL_PAYER);
    assert.equal(foreign.status, "failed");
  });

  it("lets Relay (and LI.FI) settle on a v1 Solana fill", async () => {
    const usdc = asset("solana", "USDC");
    assert.equal(usdc.address, USDC_MINT);
    const blockTime = USDC_FILL.getTransactionJson.blockTime;
    assert.deepEqual(await destinationCredit("solana", USDC_FILL.signature, usdc, USDC_RECIPIENT, blockTime - 60), { confirmed: true, credited: 233_883n });
    // A fill older than the step proves nothing.
    assert.deepEqual(await destinationCredit("solana", USDC_FILL.signature, usdc, USDC_RECIPIENT, blockTime + 1), { confirmed: false, credited: null });
  });

  it("keeps a transaction whose version this client cannot read unconfirmed, never failed, and logs it once", async () => {
    rpc.refuseEveryVersion = true;
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const observation = await observeSolanaTransaction("solana", SOL_FILL.signature, SOL_FILL_PAYER);
      assert.equal(observation.status, "processed");
      assert.equal(observation.detailsAvailable, false);
      assert.equal(observation.error, SOLANA_VERSION_UNREADABLE);
      assert.deepEqual(await readSolanaCredit("solana", SOL_FILL.signature, SOL_RECIPIENT, null), { status: "pending", credited: null, blockTime: null });
      assert.equal((await verifySolanaTransaction("solana", SOL_FILL.signature, SOL_FILL_PAYER)).status, "processed");
    } finally {
      console.warn = warn;
    }
    assert.equal(warnings.length, 1, warnings.join("\n"));
    assert.match(warnings[0] ?? "", new RegExp(SOL_FILL.signature, "u"));
  });
});

describe("deBridge DLN settlement on a v1 Solana fill", () => {
  let mock: CrossChainMock;
  let v1: V1Rpc;

  beforeEach(() => {
    // The cross-network mock answers EVM and provider calls; the v1 fixtures are layered on top of it.
    rpc.restore();
    mock = installCrossChainMock();
    resetDlnFixFeeCache();
    mock.solanaAccounts.set(DLN_SOLANA_STATE, dlnStateInfo());
    v1 = installV1Rpc(false);
  });

  afterEach(() => {
    v1.restore();
    mock.restore();
    rpc = installV1Rpc(true);
  });

  it("settles with the credited amount, capped at the order's take amount", async () => {
    const takeAmount = 233_000n;
    const action = bridgeAction("base", "solana", { amount: "250000", recipient: USDC_RECIPIENT });
    const { data, salt, creation } = dlnEvmCall(action, { takeAmount });
    const orderId = randomEvmHash();
    mock.dlnOrder = () => dlnOrderBody(action, { data }, { takeAmount, orderId });
    mock.allowance = 250_000n;
    const prepared = await debridgeDlnAdapter.prepare({ graph: {} as never, step: evmBridgeStep(action, "debridge-dln", []), action, now: Date.now() });
    const [deposit] = landPrepared(mock.rpc, prepared.transactions, [createdOrderLog(dlnEventOrder(action, creation, salt, 0n), orderId, 0n)]);
    const step = evmBridgeStep(action, "debridge-dln", prepared.transactions, { references: [deposit as string], trackingIds: [orderId], minimum: "230000" });
    assert.ok(Date.parse(step.prepared?.preparedAt ?? "") === PREPARED_AT && USDC_FILL.getTransactionJson.blockTime * 1000 > PREPARED_AT);
    mock.dlnOrders.set(orderId, { orderId: { stringValue: orderId }, state: "Fulfilled", fulfilledDstEventMetadata: { transactionHash: { stringValue: USDC_FILL.signature } } });
    const settled: SettlementResult | undefined = await debridgeDlnAdapter.poll?.(step, Date.now());
    assert.equal(settled?.status, "settled", JSON.stringify(settled));
    assert.equal(settled?.status === "settled" ? settled.actualOutput?.amount : null, "233000");
    assert.equal(settled?.status === "settled" ? settled.evidence[0]?.reference : null, USDC_FILL.signature);
    assert.ok(v1.requests.some((request) => request.method === "getTransaction"));
    assert.deepEqual(mock.rpc.unknown, []);
  });
});

/* ------------------------------------------------- unsigned v1 payloads */

const PAYER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const MEMO = SOLANA_PROGRAM_IDS.memo;

/** An unsigned v1 transaction (one memo instruction) with `config`. */
function v1Transaction(config: Parameters<typeof setTransactionMessageConfig>[0]): string {
  const message = pipe(
    createTransactionMessage({ version: 1 }),
    (draft) => setTransactionMessageFeePayer(address(PAYER), draft),
    (draft) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash("11111111111111111111111111111111"), lastValidBlockHeight: 1n }, draft),
    (draft) => appendTransactionMessageInstruction({ programAddress: address(MEMO), data: new Uint8Array([104, 105]) }, draft),
    (draft) => setTransactionMessageConfig(config, draft),
  );
  return getBase64EncodedWireTransaction(compileTransaction(message));
}

/** Rewrites the compiled config of a v1 wire transaction (mask and values as given, nothing validated). */
function withRawConfig(base64: string, configMask: number, configValues: ({ kind: "u32"; value: number } | { kind: "u64"; value: bigint })[]): string {
  const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(base64));
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  assert.equal(message.version, 1);
  const messageBytes = getCompiledTransactionMessageEncoder().encode({ ...message, configMask, configValues } as typeof message);
  return Buffer.from(getTransactionEncoder().encode({ messageBytes, signatures: transaction.signatures } as never)).toString("base64");
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof PlatformError, String(error));
    return `${error.code}: ${error.message}`;
  }
  return "OK";
}

describe("unsigned version 1 payloads", () => {
  it("inspects a recorded v1 wire transaction exactly as the RPC decodes it", () => {
    for (const fixture of [USDC_FILL, SOL_FILL]) {
      const info = inspectUnsignedSolanaTransaction(fixture.wireBase64);
      const message = fixture.getTransactionJson.transaction.message;
      assert.equal(info.version, 1);
      assert.equal(info.feePayer, message.accountKeys[0]);
      assert.deepEqual(info.signers, message.accountKeys.slice(0, message.header.numRequiredSignatures));
      assert.deepEqual(info.programs, [...new Set(message.instructions.map((instruction) => message.accountKeys[instruction.programIdIndex]))]);
      const config = message.transactionConfig;
      assert.deepEqual(info.config, {
        priorityFeeLamports: config.priorityFee === null ? null : BigInt(config.priorityFee),
        computeUnitLimit: config.computeUnitLimit,
        loadedAccountsDataSizeLimit: config.loadedAccountsDataSizeLimit,
        heapSize: config.heapSize,
      });
    }
    // 1,767 bytes: above the legacy packet size, within the v1 limit.
    assert.ok(Buffer.from(USDC_FILL.wireBase64, "base64").length > 1_232);
    assert.equal(assertSolanaTransactionOwner(USDC_FILL.wireBase64, USDC_FILL_PAYER).feePayer, USDC_FILL_PAYER);
    // Two required signers: never handed to a single wallet.
    assert.match(codeOf(() => assertSolanaTransactionOwner(SOL_FILL.wireBase64, SOL_FILL_PAYER)), /^PROVIDER_TRANSACTION_REJECTED/u);
  });

  it("decodes v1 instructions with account roles (no lookup tables)", async () => {
    const decoded = await decodeSolanaTransaction("solana", USDC_FILL.wireBase64);
    const message = USDC_FILL.getTransactionJson.transaction.message;
    assert.equal(decoded.version, 1);
    assert.deepEqual(decoded.lookupTables, []);
    assert.equal(decoded.instructions.length, message.instructions.length);
    const readonlyFrom = message.accountKeys.length - message.header.numReadonlyUnsignedAccounts;
    message.instructions.forEach((instruction, index) => {
      const view = decoded.instructions[index];
      assert.equal(view?.program, message.accountKeys[instruction.programIdIndex]);
      assert.deepEqual(view?.accounts, instruction.accounts.map((position) => message.accountKeys[position]));
      assert.deepEqual(view?.data, Uint8Array.from(getBase58Encoder().encode(instruction.data)));
      instruction.accounts.forEach((position, slot) => {
        assert.equal(view?.metas[slot]?.signer, position < message.header.numRequiredSignatures);
        assert.equal(view?.metas[slot]?.writable, position < message.header.numRequiredSignatures || position < readonlyFrom);
      });
    });
    assert.equal(rpc.requests.length, 0, "no lookup tables to read");
  });

  it("holds the v1 config to the compute-budget caps and refuses unknown config fields", () => {
    const capped = v1Transaction({ computeUnitLimit: 1_400_000, priorityFeeLamports: MAX_V1_PRIORITY_FEE_LAMPORTS, heapSize: 256 * 1024, loadedAccountsDataSizeLimit: 64 * 1024 * 1024 });
    assert.equal(MAX_V1_PRIORITY_FEE_LAMPORTS, 1_400_000n);
    assert.deepEqual(assertSolanaTransactionOwner(capped, PAYER).config, {
      priorityFeeLamports: 1_400_000n,
      computeUnitLimit: 1_400_000,
      loadedAccountsDataSizeLimit: 64 * 1024 * 1024,
      heapSize: 256 * 1024,
    });
    assert.deepEqual(inspectUnsignedSolanaTransaction(v1Transaction({})).config, { priorityFeeLamports: null, computeUnitLimit: null, loadedAccountsDataSizeLimit: null, heapSize: null });
    assert.equal(
      codeOf(() => inspectUnsignedSolanaTransaction(v1Transaction({ computeUnitLimit: 200_000, priorityFeeLamports: MAX_V1_PRIORITY_FEE_LAMPORTS + 1n }))),
      "PROVIDER_TRANSACTION_REJECTED: The provider transaction sets a priority fee above the cap.",
    );
    const base = v1Transaction({});
    assert.equal(codeOf(() => inspectUnsignedSolanaTransaction(withRawConfig(base, 4, [{ kind: "u32", value: 1_400_001 }]))), "PROVIDER_TRANSACTION_REJECTED: The provider transaction requests too many compute units.");
    assert.equal(codeOf(() => inspectUnsignedSolanaTransaction(withRawConfig(base, 16, [{ kind: "u32", value: 1_000 }]))), "PROVIDER_TRANSACTION_REJECTED: The provider transaction requests an invalid heap frame.");
    assert.equal(codeOf(() => inspectUnsignedSolanaTransaction(withRawConfig(base, 8, [{ kind: "u32", value: 64 * 1024 * 1024 + 1 }]))), "PROVIDER_TRANSACTION_REJECTED: The provider transaction requests too much loaded account data.");
    // A config field this client does not know (bit 5) could hide a cost: refused as undecodable.
    assert.match(codeOf(() => inspectUnsignedSolanaTransaction(withRawConfig(base, 0x20, []))), /^PROVIDER_TRANSACTION_INVALID/u);
    // Half a priority-fee mask is malformed.
    assert.match(codeOf(() => inspectUnsignedSolanaTransaction(withRawConfig(base, 1, [{ kind: "u64", value: 1n }]))), /^PROVIDER_TRANSACTION_INVALID/u);
  });
});
