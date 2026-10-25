/**
 * Journey contract, `kletia.journey/v1`: where the money is after every step of
 * an intent, and what follows from it.
 *
 * A journey is a deterministic per-stop ledger of one intent. Every step
 * boundary becomes a stop (network, who holds the money, asset and its
 * identity, expected and at-least amounts, USD value with its source and
 * time, custody, ETA) and every step a leg (venue, signatures, ETA, refund
 * path). Next to it, consequences: what follows from each stop, with a
 * severity assigned by rule (R1-R12), an honest certainty, the facts used and
 * concrete options. The journey never simulates: it reads the preview (the
 * fare stays the authority for what moves) and facts the engine gathered
 * under a budget; a fact that could not be read is reported as unknown, never
 * guessed.
 *
 * This module holds the types and constants every surface shares (API, SDK,
 * widget, web) and the pure builder: `buildJourney` (stops, legs, holdings,
 * custody, valuation, consequences, digest), `journeyDigest`,
 * `actionsFromGraph`, `continuationRequest`, `openBlockers` and
 * `refundPath`. No I/O: the engine gathers the facts.
 *
 * The modules live in ./journey/.
 */
export * from "./journey/constants.js";
export * from "./journey/types.js";
export { assetIdentity, refundPath } from "./journey/helpers.js";
export * from "./journey/build.js";
export * from "./journey/continuation.js";
