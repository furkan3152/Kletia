/**
 * A relay that fails says in words that the order was not placed and why
 * (never a bare 502): CoW unreachable, CoW rejecting the order, rate limits.
 *
 *   cd apps/api && node --import tsx --test src/platform/http/__tests__/orderRelayErrors.test.ts
 */
import assert from "node:assert/strict";
import { it } from "node:test";

import { SolanaProviderError } from "../../../networks/solana/index.js";
import { PlatformError } from "../../errors.js";
import { relayFailure } from "../../orders/service.js";

it("an unreachable CoW Protocol: the order was not placed, nothing was sold", () => {
  const error = relayFailure("cow-protocol", "create", new SolanaProviderError("CoW Protocol is unreachable: network error.", "COW_PROTOCOL_UNAVAILABLE"));
  assert.equal(error.code, "ORDER_RELAY_FAILED");
  assert.equal(error.status, 502);
  assert.equal(error.message, "The order was not placed on CoW Protocol: it could not be reached. Nothing was sold. Try again shortly.");
});

it("CoW rejecting the order passes its reason on", () => {
  const rejected = new SolanaProviderError("CoW Protocol rejected the request: The order's sell token balance is insufficient.", "COW_PROTOCOL_REJECTED", 422);
  const error = relayFailure("cow-protocol", "create", rejected);
  assert.match(error.message, /^The order was not placed on CoW Protocol: it refused it \(The order's sell token balance is insufficient\)\. Nothing was sold\./u);
});

it("a cancellation that could not be sent says the order stays as it was", () => {
  const error = relayFailure("jupiter-trigger", "cancel", new SolanaProviderError("Jupiter is unreachable: timeout.", "JUPITER_UNAVAILABLE"));
  assert.match(error.message, /^The cancellation was not sent to Jupiter: it could not be reached\. The order stays as it was\./u);
});

it("a client error of Kletia's own is kept as it is", () => {
  const own = new PlatformError("ORDER_SIGNATURE_MISMATCH", "Sign exactly the prepared payload.", 422);
  assert.equal(relayFailure("cow-protocol", "create", own), own);
});
