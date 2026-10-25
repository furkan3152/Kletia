/**
 * Intent response envelopes: every route a network engine returns is
 * re-checked here before it reaches a signer. The modules live in
 * ./responseEnvelope/.
 */
export { IntentResponseError } from "./responseEnvelope/types.js";
export * from "./responseEnvelope/envelope.js";
