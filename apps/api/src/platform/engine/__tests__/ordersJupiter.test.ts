/**
 * Jupiter native orders against recorded responses (fixtures/orders,
 * recorded 2026-10-23 from lite-api.jup.ag Trigger and Recurring V1; order
 * lists trimmed to three orders and two fills each): request mapping, the
 * transaction checks, the order-list mapping, `/execute`, and the signed
 * transaction guard with a real signed order transaction from mainnet
 * (signature 2AFh…xKh1).
 *
 *   cd apps/api && node --import tsx --test src/platform/engine/__tests__/ordersJupiter.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { JUPITER_API_URL } from "../../../networks/solana/index.js";
import { configureProviderRetry } from "../../../shared/http/providerRetry.js";
import type { PlatformError } from "../../errors.js";
import { resolveAsset } from "../assets.js";
import {
  JUPITER_RECURRING_PROGRAM,
  JUPITER_TRIGGER_PROGRAM,
  executeJupiterOrder,
  jupiterRecurringProvider,
  jupiterTriggerProvider,
  mapRecurringOrder,
  mapTriggerOrder,
} from "../../orders/jupiter.js";
import { planAmounts, planNativeOrder, type NativeOrderInput } from "../../orders/plan.js";
import { checkOrderTransaction, verifySignedOrderTransaction } from "../../orders/solanaGuard.js";
import type { NativeOrderRequest } from "../../orders/types.js";

const fixture = (name: string) => JSON.parse(fs.readFileSync(new URL(`./fixtures/orders/${name}`, import.meta.url), "utf8"));
const DOCS_WALLET = "jdocuPgEAjMfihABsPgKEvYtsmMzjUHeq9LX4Hvs7f3";
const TRIGGER_USER = "9v3JUtVwZ6N7MLRonkCdLVjpuP3tMJBJvo9ATWRpXhj9";
const RECURRING_USER = "GAdn7TZhszf5KTfwNRx3A2nP6KCRFEWucZubgdEqbJA2";

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly body: Record<string, unknown> | null;
}

const previousFetch = globalThis.fetch;
let sent: Sent[] = [];
let answers: unknown[] = [];

beforeEach(() => {
  sent = [];
  answers = [];
  configureProviderRetry({ sleep: async () => undefined });
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    sent.push({ url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : null });
    const next = answers.shift();
    if (next === undefined) throw new Error(`unexpected fetch ${String(url)}`);
    return next instanceof Response ? next : new Response(JSON.stringify(next), { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = previousFetch;
  configureProviderRetry(null);
});

async function request(input: NativeOrderInput, owner: string): Promise<NativeOrderRequest> {
  const plan = planNativeOrder(input);
  const [sell, buy] = await Promise.all([resolveAsset(plan.network, plan.sell), resolveAsset(plan.network, plan.buy)]);
  return { plan, owner, sell, buy, ...planAmounts(plan, sell.decimals, buy.decimals) };
}

/** The recorded signed transaction with its signature zeroed: what Jupiter handed the wallet. */
function unsignedOf(signed: string): string {
  const bytes = Buffer.from(signed, "base64");
  bytes.fill(0, 1, 65);
  return bytes.toString("base64");
}

describe("Jupiter Trigger (limit orders)", () => {
  it("maps a limit order to createOrder and checks the returned transaction", async () => {
    answers.push(fixture("trigger-create.json"));
    const draft = await jupiterTriggerProvider.prepare(await request({ kind: "limit", sell: "USDC", buy: "SOL", amount: "10", price: "0.005" }, DOCS_WALLET));
    assert.equal(sent[0]!.url, `${JUPITER_API_URL}/trigger/v1/createOrder`);
    assert.deepEqual(sent[0]!.body, {
      inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      outputMint: "So11111111111111111111111111111111111111112",
      maker: DOCS_WALLET,
      payer: DOCS_WALLET,
      params: { makingAmount: "10000000", takingAmount: "50000000" },
      computeUnitPrice: "auto",
      wrapAndUnwrapSol: true,
    });
    assert.equal(draft.orderId, "jupiter-trigger:solana:HugwigsGKvhcat6LMiZrQQAE2gxhq5etL1V9nnHitrWZ");
    assert.deepEqual(draft.relay, { kind: "jupiter-execute", api: "trigger", requestId: "c9c0b1bd-92b8-45d2-978a-3e4f32eaa6d7" });
    const step = draft.steps[0]!;
    assert.equal(step.kind, "solana-transaction");
    assert.equal(step.kind === "solana-transaction" && step.messageHash.length, 64);
    assert.equal(draft.submit, "kletia");
  });

  it("sends an expiry and refuses a transaction for another wallet", async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 3_600;
    answers.push(fixture("trigger-create.json"));
    await assert.rejects(
      jupiterTriggerProvider.prepare(await request({ kind: "limit", sell: "USDC", buy: "SOL", amount: "10", price: "0.005", expiresAt }, TRIGGER_USER)),
      (error: unknown) => (error as PlatformError).code === "PROVIDER_TRANSACTION_REJECTED",
    );
    assert.equal((sent[0]!.body!.params as Record<string, unknown>).expiredAt, String(expiresAt));
  });

  it("only accepts the order program plus the support programs", () => {
    const { transaction } = fixture("trigger-create.json");
    assert.match(checkOrderTransaction(transaction, DOCS_WALLET, JUPITER_TRIGGER_PROGRAM), /^[0-9a-f]{64}$/u);
    assert.throws(() => checkOrderTransaction(transaction, DOCS_WALLET, JUPITER_RECURRING_PROGRAM), (error: unknown) => (error as PlatformError).code === "PROVIDER_TRANSACTION_REJECTED");
  });

  it("maps recorded open and past orders", () => {
    const open = mapTriggerOrder(fixture("trigger-active.json").orders[0]);
    assert.equal(open.id, "jupiter-trigger:solana:7EAm19kDswFGjkd9tq6AfXWXDdVJwPr8hxVM2otxAn9G");
    assert.equal(open.status, "open");
    assert.equal(open.cancellable, true);
    assert.equal(open.sell.symbol, "USDC");
    assert.equal(open.sell.formatted, "25");
    assert.equal(open.buy?.decimals, 6, "decimals read from the provider's own raw and human amounts");
    assert.equal(open.buy?.formatted, "702.730179");
    assert.equal(open.expiresAt, "2026-10-24T15:42:50.000Z");
    const past = mapTriggerOrder(fixture("trigger-history.json").orders[0]);
    assert.equal(past.status, "cancelled");
    assert.equal(past.cancellable, false);
    assert.equal(mapTriggerOrder({ ...fixture("trigger-history.json").orders[0], status: "Weird" }).status, "unknown");
  });

  it("prepares a cancel only for the owner's open order", async () => {
    answers.push(fixture("trigger-active.json"), fixture("trigger-cancel.json"));
    const ref = { protocol: "jupiter-trigger" as const, network: "solana" as const, nativeId: "7EAm19kDswFGjkd9tq6AfXWXDdVJwPr8hxVM2otxAn9G" };
    const draft = await jupiterTriggerProvider.cancel(ref, TRIGGER_USER);
    assert.deepEqual(sent[1]!.body, { maker: TRIGGER_USER, order: ref.nativeId, computeUnitPrice: "auto" });
    assert.equal(draft.action, "cancel");
    assert.equal(draft.relay.kind === "jupiter-execute" && draft.relay.requestId, "9eff81ac-f144-4711-992b-224eee5522e5");

    answers.push(fixture("trigger-active.json"), fixture("trigger-history.json"));
    await assert.rejects(jupiterTriggerProvider.cancel({ ...ref, nativeId: "D1USBW8ftifZBhdUqeNcsar4Ve6AuoWNi3aMe8kgePra" }, TRIGGER_USER), (error: unknown) => (error as PlatformError).code === "ORDER_NOT_CANCELLABLE");
  });

  it("relays through /execute and refuses a failed execution", async () => {
    const signature = fixture("trigger-open-signed.json").signature;
    answers.push({ signature, status: "Success", code: 0 });
    assert.deepEqual(await executeJupiterOrder("trigger", "req-12345678", "AQ=="), { signature, order: null });
    assert.deepEqual(sent[0]!.body, { requestId: "req-12345678", signedTransaction: "AQ==" });
    answers.push({ signature, status: "Failed", error: "custom program error: 0x1", code: 0 });
    await assert.rejects(executeJupiterOrder("trigger", "req-12345678", "AQ=="), (error: unknown) => (error as PlatformError).code === "ORDER_RELAY_FAILED" && /0x1/u.test((error as Error).message));
  });
});

describe("Jupiter Recurring (DCA)", () => {
  it("maps a DCA to a time-based createOrder", async () => {
    answers.push(fixture("recurring-create.json"));
    const draft = await jupiterRecurringProvider.prepare(await request({ kind: "dca", sell: "USDC", buy: "SOL", amount: "200", period: "day", count: 2 }, DOCS_WALLET));
    assert.equal(sent[0]!.url, `${JUPITER_API_URL}/recurring/v1/createOrder`);
    assert.deepEqual(sent[0]!.body!.params, { time: { inAmount: 200_000_000, numberOfOrders: 2, interval: 86_400, minPrice: null, maxPrice: null, startAt: null } });
    assert.equal(draft.orderId, null, "the order account is known after execution");
    assert.equal(draft.relay.kind === "jupiter-execute" && draft.relay.api, "recurring");
  });

  it("refuses a price floor it would not enforce", async () => {
    await assert.rejects(
      jupiterRecurringProvider.prepare(await request({ kind: "dca", sell: "USDC", buy: "SOL", amount: "200", period: "day", count: 2, price: "0.004" }, DOCS_WALLET)),
      (error: unknown) => (error as PlatformError).code === "ORDER_UNSUPPORTED",
    );
  });

  it("maps recorded recurring orders", () => {
    const open = mapRecurringOrder(fixture("recurring-active.json").time[0], true);
    assert.equal(open.id, "jupiter-recurring:solana:G1wnaWMJ7VTRnryBHvxNwWmwUDD5yUNBmLvZkRK1mPcT");
    assert.equal(open.owner, RECURRING_USER);
    assert.equal(open.status, "open");
    assert.equal(open.schedule?.periodSeconds, 1_200);
    assert.equal(open.schedule?.perPart.formatted, "553.693168");
    assert.equal(open.sold.formatted, "325571.582784");
    const past = mapRecurringOrder(fixture("recurring-history.json").time[0], false);
    assert.equal(past.status, "filled");
    assert.equal(past.cancellable, false);
  });

  it("checks the recorded cancel transaction against the DCA program", () => {
    const { transaction } = fixture("recurring-cancel.json");
    assert.match(checkOrderTransaction(transaction, RECURRING_USER, JUPITER_RECURRING_PROGRAM), /^[0-9a-f]{64}$/u);
  });
});

describe("signed transaction guard", () => {
  const recorded = fixture("trigger-open-signed.json") as { signature: string; signedTransaction: string };
  const hash = checkOrderTransaction(unsignedOf(recorded.signedTransaction), TRIGGER_USER, JUPITER_TRIGGER_PROGRAM);
  const mismatch = (error: unknown) => (error as PlatformError).code === "ORDER_SIGNATURE_MISMATCH";

  it("accepts the owner's real signature over the prepared message", async () => {
    assert.equal(await verifySignedOrderTransaction(recorded.signedTransaction, TRIGGER_USER, hash), recorded.signature);
  });

  it("refuses a changed message, a changed signature, another owner and an unsigned copy", async () => {
    const bytes = Buffer.from(recorded.signedTransaction, "base64");
    const changedMessage = Buffer.from(bytes);
    changedMessage[changedMessage.length - 1] ^= 1;
    await assert.rejects(verifySignedOrderTransaction(changedMessage.toString("base64"), TRIGGER_USER, hash), mismatch);
    const changedSignature = Buffer.from(bytes);
    changedSignature[10] ^= 1;
    await assert.rejects(verifySignedOrderTransaction(changedSignature.toString("base64"), TRIGGER_USER, hash), mismatch);
    await assert.rejects(verifySignedOrderTransaction(recorded.signedTransaction, DOCS_WALLET, hash), mismatch);
    await assert.rejects(verifySignedOrderTransaction(unsignedOf(recorded.signedTransaction), TRIGGER_USER, hash), mismatch);
    await assert.rejects(verifySignedOrderTransaction("not base64!", TRIGGER_USER, hash), mismatch);
  });
});
