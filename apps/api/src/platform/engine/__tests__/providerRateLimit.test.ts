/**
 * Upstream rate limits (GAPS 3.5): a provider's 429 ("Too many requests")
 * is retried briefly, then reported as PROVIDER_RATE_LIMITED (503,
 * retryable, Retry-After), never as a non-retryable <PROVIDER>_REJECTED.
 * Identical Jupiter quotes within seconds share one upstream call.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { describeError } from "@kletia/core";
import { configureJupiterQuoteCache, quoteJupiterSwap } from "../../../networks/solana/index.js";
import { configureProviderRetry, parseRetryAfter } from "../../../shared/http/providerRetry.js";
import { PlatformError, toPlatformError } from "../../errors.js";
import { sendError } from "../../http/context.js";
import { fetchProviderJson } from "../http.js";

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function quoteBody(amount: string, out = "103509531") {
  return {
    inputMint: SOL,
    outputMint: USDC,
    inAmount: amount,
    outAmount: out,
    otherAmountThreshold: "1",
    slippageBps: 50,
    priceImpactPct: "0.0001",
    routePlan: [{ percent: 100, swapInfo: { label: "Whirlpool", inputMint: SOL, outputMint: USDC } }],
    contextSlot: 1,
  };
}

const previousFetch = globalThis.fetch;
let answers: (() => Response)[] = [];
let calls = 0;
let slept: number[] = [];

beforeEach(() => {
  calls = 0;
  slept = [];
  answers = [];
  configureProviderRetry({ sleep: async (ms) => { slept.push(ms); } });
  configureJupiterQuoteCache(null);
  globalThis.fetch = (async () => {
    calls += 1;
    const next = answers.shift();
    if (!next) throw new Error("unexpected fetch");
    return next();
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = previousFetch;
  configureProviderRetry(null);
  configureJupiterQuoteCache(null);
});

const tooMany = (retryAfter?: string) => () =>
  new Response(JSON.stringify({ message: "Too many requests" }), { status: 429, headers: retryAfter ? { "retry-after": retryAfter } : {} });
const json = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200 });

function capture(error: unknown): { status: number; headers: Map<string, string>; body: { error: { code: string; message: string; docs?: string } } } {
  const headers = new Map<string, string>();
  let status = 0;
  let body: unknown;
  const req = { get: () => undefined } as unknown as Parameters<typeof sendError>[0];
  const res = {
    headersSent: false,
    setHeader: (name: string, value: string) => headers.set(name.toLowerCase(), value),
    getHeader: (name: string) => headers.get(name.toLowerCase()),
    destroy: () => undefined,
    status(code: number) {
      status = code;
      return { json: (value: unknown) => { body = value; } };
    },
  } as unknown as Parameters<typeof sendError>[1];
  sendError(req, res, error);
  return { status, headers, body: body as { error: { code: string; message: string; docs?: string } } };
}

describe("provider rate limits", () => {
  it("parses Retry-After seconds and HTTP dates", () => {
    assert.equal(parseRetryAfter(null), null);
    assert.equal(parseRetryAfter("3"), 3);
    assert.equal(parseRetryAfter("soon"), null);
    assert.equal(parseRetryAfter(new Date(10_000).toUTCString(), 4_000), 6);
  });

  it("retries a Jupiter 429 briefly and returns the quote", async () => {
    answers = [tooMany(), tooMany("1"), json(quoteBody("1000000000"))];
    const quote = await quoteJupiterSwap({ inputMint: SOL, outputMint: USDC, amount: "1000000000" });
    assert.equal(quote.outAmount, "103509531");
    assert.equal(calls, 3);
    assert.deepEqual(slept, [300, 1000]);
  });

  it("reports a lasting Jupiter 429 as PROVIDER_RATE_LIMITED 503 with Retry-After, not JUPITER_REJECTED", async () => {
    answers = [tooMany("1"), tooMany(), tooMany("4")];
    const error = await quoteJupiterSwap({ inputMint: SOL, outputMint: USDC, amount: "2000000000" }).then(
      () => assert.fail("expected a rate limit"),
      (failure: unknown) => toPlatformError(failure),
    );
    assert.equal(calls, 3, "the first two answers were retried");
    assert.equal(error.code, "PROVIDER_RATE_LIMITED");
    assert.equal(error.status, 503);
    assert.match(error.message, /^Jupiter is limiting requests right now/u);
    const response = capture(error);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "4");
    assert.equal(response.body.error.code, "PROVIDER_RATE_LIMITED");
    assert.match(response.body.error.docs ?? "", /#error-PROVIDER_RATE_LIMITED$/u);
    assert.equal(describeError(response.body.error.code)?.retryable, true);
  });

  it("does not wait in-request for a long Retry-After", async () => {
    answers = [tooMany("30")];
    const error = await quoteJupiterSwap({ inputMint: SOL, outputMint: USDC, amount: "3000000000" }).then(
      () => assert.fail("expected a rate limit"),
      (failure: unknown) => toPlatformError(failure),
    );
    assert.equal(calls, 1);
    assert.deepEqual(slept, []);
    assert.equal(error.code, "PROVIDER_RATE_LIMITED");
    assert.equal((error as PlatformError & { retryAfterSeconds?: number }).retryAfterSeconds, 30);
  });

  it("maps a lasting 429 of an EVM-side provider the same way", async () => {
    answers = [tooMany(), tooMany(), tooMany()];
    const error = await fetchProviderJson("https://relay.example/quote", { provider: "Relay" }).then(
      () => assert.fail("expected a rate limit"),
      (failure: unknown) => toPlatformError(failure),
    );
    assert.equal(calls, 3);
    assert.equal(error.code, "PROVIDER_RATE_LIMITED");
    assert.equal(capture(error).headers.get("retry-after"), "2");
  });

  it("leaves a 429 to callers that handle it themselves", async () => {
    answers = [tooMany()];
    assert.equal(await fetchProviderJson("https://li.example/quote", { provider: "LI.FI", allowStatus: [429] }), null);
    assert.equal(calls, 1);
  });

  it("keeps other refusals as they were", async () => {
    answers = [() => new Response(JSON.stringify({ error: "Could not find any route" }), { status: 400 })];
    const error = await quoteJupiterSwap({ inputMint: SOL, outputMint: USDC, amount: "4000000000" }).then(
      () => assert.fail("expected a refusal"),
      (failure: unknown) => toPlatformError(failure),
    );
    assert.equal(error.code, "JUPITER_REJECTED");
    assert.equal(error.status, 422);
  });
});

describe("Jupiter quote cache", () => {
  it("answers an identical quote from memory for a few seconds and shares one call in flight", async () => {
    answers = [json(quoteBody("5000000000"))];
    const request = { inputMint: SOL, outputMint: USDC, amount: "5000000000" };
    const [first, second] = await Promise.all([quoteJupiterSwap(request), quoteJupiterSwap(request)]);
    const third = await quoteJupiterSwap(request);
    assert.equal(calls, 1);
    assert.equal(first, second);
    assert.equal(first, third);
  });

  it("asks again for a fresh quote, another amount or after a failure", async () => {
    const request = { inputMint: SOL, outputMint: USDC, amount: "6000000000" };
    answers = [json(quoteBody("6000000000", "600")), json(quoteBody("6000000000", "601"))];
    assert.equal((await quoteJupiterSwap(request)).outAmount, "600");
    assert.equal((await quoteJupiterSwap({ ...request, fresh: true })).outAmount, "601");
    assert.equal((await quoteJupiterSwap(request)).outAmount, "601", "the fresh quote refreshed the cache");
    answers = [() => new Response("{}", { status: 500 }), json(quoteBody("7000000000"))];
    await assert.rejects(quoteJupiterSwap({ ...request, amount: "7000000000" }));
    assert.equal((await quoteJupiterSwap({ ...request, amount: "7000000000" })).inAmount, "7000000000");
    assert.equal(calls, 4);
  });

  it("can be switched off", async () => {
    configureJupiterQuoteCache({ ttlMs: 0 });
    const request = { inputMint: SOL, outputMint: USDC, amount: "8000000000" };
    answers = [json(quoteBody("8000000000")), json(quoteBody("8000000000"))];
    await quoteJupiterSwap(request);
    await quoteJupiterSwap(request);
    assert.equal(calls, 2);
  });
});
