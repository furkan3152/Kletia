/**
 * Secret screen for free text that reaches the engine (intent text from
 * POST /v1/intents, sessions, links, MCP plan_intent and the policy tools,
 * and the clarify layer's messages and answers). A private key, a seed
 * phrase, a PEM private key, a labelled API key or token, or a bearer
 * credential is refused with 400 MESSAGE_SECRET_REFUSED before anything is
 * planned, stored or logged. The rules are shared/security/promptSecrets.ts
 * (the same module the web client screens prompts with; both are checked
 * against packages/core/test/fixtures/secret-vectors.json). The refusal never
 * repeats the text.
 */
import { containsSensitivePromptMaterial } from "../../shared/security/promptSecrets.js";
import { PlatformError } from "../errors.js";

/** Longest text screened (longer text is refused by validation first; this bounds the BIP39 scan). */
const MAX_SCREENED_CHARS = 20_000;

export const SECRET_REFUSED_MESSAGE =
  "The text looks like it contains a private key, a seed phrase or an API key. Never send secrets to Kletia: nothing was planned or stored.";

/** True when `text` carries secret material. */
export function containsSecret(text: string): boolean {
  return containsSensitivePromptMaterial(text.slice(0, MAX_SCREENED_CHARS));
}

/** Throws MESSAGE_SECRET_REFUSED (400) when `text` carries secret material; `path` names the field in the issue. */
export function assertNoSecret(text: unknown, path = "text"): void {
  if (typeof text !== "string" || text.length === 0) return;
  if (!containsSecret(text)) return;
  throw new PlatformError("MESSAGE_SECRET_REFUSED", SECRET_REFUSED_MESSAGE, 400, [{ path, message: "Looks like secret material; it was not stored." }]);
}

/** Screens the free text of an intent request (its `text`) before it is validated, planned or stored. */
export function screenIntentRequest(request: unknown): void {
  if (typeof request !== "object" || request === null) return;
  assertNoSecret((request as { text?: unknown }).text, "text");
}
