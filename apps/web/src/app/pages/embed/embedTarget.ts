/**
 * Target scoping of the `/embed` frame. A host may move the frame from one
 * integrator target to another (`#session=A` to `#session=B`, or to an
 * `#intent=`) without reloading it. Everything the frame holds for a target
 * is keyed by it: the intent a session created for this visitor is only
 * reopened while that same session is the target, and the widget (with its
 * signer lease) remounts when the target changes, so B never shows A's
 * intent and A's signers stop working.
 */
import type { EmbedTarget } from "./embedParams.ts";

/** The intent a session created for this visitor, remembered with the session it belongs to. */
export interface SessionIntent {
  readonly sessionId: string;
  readonly intentId: string;
}

/** A stable key for the frame's target: an integrator intent, a session, or free text. */
export function embedTargetKey(target: EmbedTarget | null): string {
  return target ? `${target.kind}:${target.id}` : "text";
}

/**
 * The intent the widget opens: the target intent itself, or the intent this
 * visitor's session created, but only while that session is still the target.
 */
export function openIntentFor(target: EmbedTarget | null, sessionIntent: SessionIntent | null): string | null {
  if (target?.kind === "intent") return target.id;
  if (target?.kind === "session" && sessionIntent?.sessionId === target.id) return sessionIntent.intentId;
  return null;
}

/**
 * The widget instance key. A new set of account owners or a new target
 * remounts the widget and replaces its signer lease; a network switch of the
 * same wallet does not (`accountsKey` holds owners, not networks).
 */
export function embedWidgetKey(live: boolean, accountsKey: string, target: EmbedTarget | null): string {
  return `${live ? `live:${accountsKey}` : "plan"}:${embedTargetKey(target)}`;
}
