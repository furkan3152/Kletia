/**
 * /v1/orders over HTTP: prepare with recorded Jupiter responses, the submit
 * guard (hash and signature match, fail closed, replay, single use, expiry)
 * with a real signed mainnet order transaction and a real CoW order
 * signature, cancels, lists with per-protocol failures, and validation.
 * Upstream calls are answered from fixtures; nothing reaches the network.
 *
 *   cd apps/api && node --import tsx --test src/platform/http/__tests__/orders.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { configureProviderRetry } from "../../../shared/http/providerRetry.js";
import { PlatformError } from "../../errors.js";
import { cowOrderTypedData, type CowOrder } from "../../orders/cowProtocol.js";
import { typedDataDigest } from "../../orders/evmGuard.js";
import { checkOrderTransaction } from "../../orders/solanaGuard.js";
import { JUPITER_TRIGGER_PROGRAM } from "../../orders/jupiter.js";
import type { NativeOrder, NativeOrderProvider, PreparedOrderDraft } from "../../orders/types.js";
import { assertError, call, serve, useTestEnvironment, type TestServer } from "./support.js";

useTestEnvironment();
const { createPlatformRouter, platformErrorHandler } = await import("../index.js");
const orders = await import("../../orders/index.js");
const { resetOrderLimiters } = await import("../orders/handlers.js");

const fixture = (name: string) => JSON.parse(fs.readFileSync(new URL(`../../engine/__tests__/fixtures/orders/${name}`, import.meta.url), "utf8"));
const DOCS_WALLET = "jdocuPgEAjMfihABsPgKEvYtsmMzjUHeq9LX4Hvs7f3";
const TRIGGER_USER = "9v3JUtVwZ6N7MLRonkCdLVjpuP3tMJBJvo9ATWRpXhj9";
const signedOrder = fixture("trigger-open-signed.json") as { signature: string; signedTransaction: string };
const cowRecorded = fixture("cow-order.json") as Record<string, string | number | boolean>;

function unsignedOf(signed: string): string {
  const bytes = Buffer.from(signed, "base64");
  bytes.fill(0, 1, 65);
  return bytes.toString("base64");
}

/** A provider whose drafts carry recorded payloads; relay calls are counted. */
function recordedProvider(protocol: "jupiter-trigger" | "cow-protocol" = "jupiter-trigger"): NativeOrderProvider & { relayed: number } {
  const transaction = unsignedOf(signedOrder.signedTransaction);
  const cowOrder: CowOrder = {
    sellToken: String(cowRecorded.sellToken), buyToken: String(cowRecorded.buyToken), receiver: String(cowRecorded.receiver),
    sellAmount: String(cowRecorded.sellAmount), buyAmount: String(cowRecorded.buyAmount), validTo: Number(cowRecorded.validTo),
    appData: String(cowRecorded.appData), feeAmount: "0", kind: "sell", partiallyFillable: false, sellTokenBalance: "erc20", buyTokenBalance: "erc20",
  };
  const typedData = cowOrderTypedData(cowOrder, 1);
  const provider = {
    relayed: 0,
    protocol,
    networks: protocol === "cow-protocol" ? ["ethereum" as const] : ["solana" as const],
    mechanisms: ["limit" as const],
    async quote() {
      throw new Error("unused");
    },
    async prepare(request): Promise<PreparedOrderDraft> {
      if (request.owner === TRIGGER_USER) {
        return {
          protocol: "jupiter-trigger", action: "create", network: "solana", owner: TRIGGER_USER, orderId: "jupiter-trigger:solana:7EAm19kDswFGjkd9tq6AfXWXDdVJwPr8hxVM2otxAn9G",
          steps: [{ kind: "solana-transaction", network: "solana", transaction, encoding: "base64", messageHash: checkOrderTransaction(transaction, TRIGGER_USER, JUPITER_TRIGGER_PROGRAM), description: "test" }],
          submit: "kletia", ttlSeconds: 90, warnings: [], relay: { kind: "jupiter-execute", api: "trigger", requestId: "req-recorded" },
        };
      }
      return {
        protocol: "cow-protocol", action: "create", network: "ethereum", owner: String(cowRecorded.owner), orderId: `cow-protocol:ethereum:${cowRecorded.uid}`,
        steps: [{ kind: "eip712", network: "ethereum", chainId: 1, typedData, digest: typedDataDigest(typedData), description: "test" }],
        submit: "kletia", ttlSeconds: 90, warnings: [], relay: { kind: "none" }, ownerIsContract: false,
      };
    },
    async list(owner: string): Promise<NativeOrder[]> {
      if (owner === DOCS_WALLET) throw new PlatformError("PROVIDER_UNAVAILABLE", "Jupiter is down.", 502);
      return [];
    },
    async status(): Promise<NativeOrder> {
      throw new PlatformError("ORDER_NOT_FOUND", "none", 404);
    },
    async cancel(): Promise<PreparedOrderDraft> {
      throw new PlatformError("ORDER_NOT_CANCELLABLE", "filled", 409);
    },
    async relay(draft: PreparedOrderDraft) {
      provider.relayed += 1;
      return draft.network === "solana"
        ? { orderId: draft.orderId, reference: signedOrder.signature, status: "submitted" as const }
        : { orderId: draft.orderId, reference: String(cowRecorded.uid), status: "submitted" as const };
    },
  } satisfies NativeOrderProvider & { relayed: number };
  return provider;
}

let server: TestServer;
const previousFetch = globalThis.fetch;
let upstream: unknown[] = [];

before(async () => {
  server = await serve((app) => app.use("/v1", createPlatformRouter(), platformErrorHandler));
});
after(async () => {
  await server.close();
});
beforeEach(() => {
  upstream = [];
  resetOrderLimiters();
  orders.resetPreparations();
  configureProviderRetry({ sleep: async () => undefined });
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    if (String(url).startsWith(server.base)) return previousFetch(url, init);
    const next = upstream.shift();
    if (next === undefined) throw new Error(`unexpected upstream fetch ${String(url)}`);
    return new Response(JSON.stringify(next), { status: 200 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = previousFetch;
  configureProviderRetry(null);
  orders.configureNativeOrderProviders(null);
  orders.configurePreparationClock(null);
});

const LIMIT = { kind: "limit", sell: "USDC", buy: "SOL", amount: "10", price: "0.005" };

describe("POST /v1/orders/prepare", () => {
  it("returns Jupiter's checked transaction and never the relay context", async () => {
    upstream.push(fixture("trigger-create.json"));
    const reply = await call<{ plan: { protocol: string }; preparation: Record<string, unknown> }>(server, "POST", "/orders/prepare", { body: { ...LIMIT, owner: DOCS_WALLET } });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(reply.body.plan.protocol, "jupiter-trigger");
    const preparation = reply.body.preparation;
    assert.match(String(preparation.id), orders.PREPARATION_ID_PATTERN);
    assert.equal(preparation.submit, "kletia");
    assert.equal("relay" in preparation, false);
    assert.equal(JSON.stringify(preparation).includes("c9c0b1bd"), false, "Jupiter's requestId stays server-side");
  });

  it("refuses bad bodies with per-field issues", async () => {
    assertError(await call(server, "POST", "/orders/prepare", { body: { ...LIMIT } }), 400, "ORDER_INVALID");
    assertError(await call(server, "POST", "/orders/prepare", { body: { ...LIMIT, owner: DOCS_WALLET, color: "red" } }), 400, "ORDER_INVALID");
    assertError(await call(server, "POST", "/orders/prepare", { body: { ...LIMIT, owner: String(cowRecorded.owner) } }), 400, "ORDER_INVALID");
    const ambiguous = assertError(await call(server, "POST", "/orders/quote", { body: { kind: "limit", sell: "WETH", buy: "USDC", amount: "1", price: "4000", owner: String(cowRecorded.owner) } }), 422, "ORDER_NETWORK_REQUIRED");
    assert.deepEqual(ambiguous.error.details?.candidates, ["ethereum", "arbitrum", "base"]);
  });
});

describe("POST /v1/orders/submit", () => {
  async function prepare(owner: string): Promise<string> {
    const evm = owner.startsWith("0x");
    orders.configureNativeOrderProviders([recordedProvider(evm ? "cow-protocol" : "jupiter-trigger")]);
    const body = evm ? { kind: "limit", sell: "WETH", buy: "USDC", amount: "1", price: "4000", network: "ethereum", owner } : { ...LIMIT, owner };
    const reply = await call<{ preparation: { id: string } }>(server, "POST", "/orders/prepare", { body });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    return reply.body.preparation.id;
  }

  it("relays a signed transaction that carries the prepared message, once", async () => {
    const id = await prepare(TRIGGER_USER);
    const first = await call<{ order: Record<string, unknown> }>(server, "POST", "/orders/submit", { body: { preparationId: id, signedTransaction: signedOrder.signedTransaction } });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(first.body.order, {
      id: "jupiter-trigger:solana:7EAm19kDswFGjkd9tq6AfXWXDdVJwPr8hxVM2otxAn9G", preparationId: id, protocol: "jupiter-trigger", network: "solana", action: "create", status: "submitted", reference: signedOrder.signature,
    });
    const again = await call(server, "POST", "/orders/submit", { body: { preparationId: id, signedTransaction: signedOrder.signedTransaction } });
    assert.equal(again.status, 200);
    assert.equal(again.headers.get("idempotent-replayed"), "true");
    const tampered = Buffer.from(signedOrder.signedTransaction, "base64");
    tampered[20] ^= 1;
    assertError(await call(server, "POST", "/orders/submit", { body: { preparationId: id, signedTransaction: tampered.toString("base64") } }), 409, "ORDER_PREPARATION_USED");
  });

  it("fails closed on a changed message or a foreign signature, and nothing is relayed", async () => {
    const id = await prepare(TRIGGER_USER);
    const bytes = Buffer.from(signedOrder.signedTransaction, "base64");
    bytes[bytes.length - 1] ^= 1;
    assertError(await call(server, "POST", "/orders/submit", { body: { preparationId: id, signedTransaction: bytes.toString("base64") } }), 422, "ORDER_SIGNATURE_MISMATCH");
    assertError(await call(server, "POST", "/orders/submit", { body: { preparationId: id, signedTransaction: unsignedOf(signedOrder.signedTransaction) } }), 422, "ORDER_SIGNATURE_MISMATCH");
    assertError(await call(server, "POST", "/orders/submit", { body: { preparationId: id, signature: "0x00" } }), 400, "ORDER_INVALID");
    const provider = orders.nativeOrderProviders()[0] as NativeOrderProvider & { relayed: number };
    assert.equal(provider.relayed, 0);
  });

  it("checks EIP-712 signatures against the prepared digest", async () => {
    const id = await prepare(String(cowRecorded.owner));
    const flipped = `${String(cowRecorded.signature).slice(0, -4)}${String(cowRecorded.signature).slice(-4) === "001c" ? "001b" : "001c"}`;
    assertError(await call(server, "POST", "/orders/submit", { body: { preparationId: id, signature: flipped } }), 422, "ORDER_SIGNATURE_MISMATCH");
    const ok = await call<{ order: { reference: string } }>(server, "POST", "/orders/submit", { body: { preparationId: id, signature: cowRecorded.signature } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.order.reference, cowRecorded.uid);
  });

  it("answers unknown and expired preparations", async () => {
    assertError(await call(server, "POST", "/orders/submit", { body: { preparationId: `ordp_${"0".repeat(32)}`, signature: "0x" } }), 404, "ORDER_PREPARATION_NOT_FOUND");
    const id = await prepare(TRIGGER_USER);
    orders.configurePreparationClock(() => Date.now() + 91_000);
    assertError(await call(server, "POST", "/orders/submit", { body: { preparationId: id, signedTransaction: signedOrder.signedTransaction } }), 410, "ORDER_PREPARATION_EXPIRED");
  });
});

describe("GET /v1/orders and cancel", () => {
  it("lists recorded Jupiter orders and reports unreadable protocols as failures", async () => {
    upstream.push(fixture("trigger-active.json"), fixture("trigger-history.json"));
    const provider = recordedProvider();
    const { jupiterTriggerProvider } = await import("../../orders/jupiter.js");
    orders.configureNativeOrderProviders([jupiterTriggerProvider]);
    const reply = await call<{ orders: NativeOrder[]; failures: unknown[] }>(server, "GET", `/orders?owner=${TRIGGER_USER}`);
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(reply.body.orders.length, 6);
    assert.deepEqual(reply.body.failures, []);
    orders.configureNativeOrderProviders([provider]);
    const failing = await call<{ orders: NativeOrder[]; failures: { code: string; protocol: string }[] }>(server, "GET", `/orders?owner=${DOCS_WALLET},${TRIGGER_USER}`);
    assert.deepEqual(failing.body.failures.map((failure) => [failure.protocol, failure.code]), [["jupiter-trigger", "PROVIDER_UNAVAILABLE"]]);
    assertError(await call(server, "GET", "/orders"), 400, "ORDER_INVALID");
    assertError(await call(server, "GET", `/orders?owner=${TRIGGER_USER}&network=polygon`), 400, "ORDER_INVALID");
  });

  it("refuses malformed ids and passes provider refusals through", async () => {
    orders.configureNativeOrderProviders([recordedProvider()]);
    assertError(await call(server, "POST", "/orders/nope/cancel", { body: { owner: TRIGGER_USER } }), 400, "ORDER_INVALID");
    assertError(await call(server, "POST", "/orders/jupiter-trigger:solana:7EAm19kDswFGjkd9tq6AfXWXDdVJwPr8hxVM2otxAn9G/cancel", { body: {} }), 400, "ORDER_INVALID");
    assertError(await call(server, "POST", "/orders/jupiter-trigger:solana:7EAm19kDswFGjkd9tq6AfXWXDdVJwPr8hxVM2otxAn9G/cancel", { body: { owner: TRIGGER_USER } }), 409, "ORDER_NOT_CANCELLABLE");
    assertError(await call(server, "GET", `/orders/jupiter-trigger:solana:7EAm19kDswFGjkd9tq6AfXWXDdVJwPr8hxVM2otxAn9G?owner=${TRIGGER_USER}`), 404, "ORDER_NOT_FOUND");
  });
});
