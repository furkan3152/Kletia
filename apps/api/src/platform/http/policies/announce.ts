/**
 * Decisions and events of rule book amendments and key lifecycle (policy
 * design §3.5, §8, §9, §11.4): `policy.amendment_pending`, `policy.amended`
 * (also for lazy and background promotions), `key.created` and
 * `key.revoked`, each with a decision in the project's hash-chained log.
 *
 * Key events have their own envelope bus (the engine's policy bus is typed
 * to `policy.*`); the webhook dispatcher subscribes to both.
 */
import { randomBytes } from "node:crypto";
import { canonicalJson, type KeyEventType, type KletiaEvent, type KletiaEventMap, type PolicyChainLink } from "@kletia/core";
import { buildEvent, platformEvents, publishPolicyEvent, type PolicyDecisionDraft } from "../../index.js";
import { sha256Hex } from "../secrets.js";
import { decisionStore } from "./decisions.js";
import { projectScope, type PolicyVersion } from "./store.js";

export type KeyEvent = { [K in KeyEventType]: KletiaEvent<K> }[KeyEventType];

const keyListeners = new Set<(event: KeyEvent) => void>();

export function publishKeyEvent<K extends KeyEventType>(type: K, data: KletiaEventMap[K]): KletiaEvent<K> {
  const event = buildEvent(type, data);
  platformEvents.emit(type, data);
  for (const listener of [...keyListeners]) {
    try {
      listener(event as unknown as KeyEvent);
    } catch (error) {
      console.error("[platform] key event listener failed:", error instanceof Error ? error.message : error);
    }
  }
  return event;
}

export function subscribeKeyEvents(listener: (event: KeyEvent) => void): () => void {
  keyListeners.add(listener);
  return () => {
    keyListeners.delete(listener);
  };
}

export function newDecisionIdHex(): string {
  return `pdc_${randomBytes(12).toString("hex")}`;
}

function versionLink(version: PolicyVersion): PolicyChainLink[] {
  return version.document && version.hash
    ? [{ scope: version.scope, id: version.scope === "project" ? projectScope(version.subjectId) : version.subjectId, version: version.version, hash: version.hash }]
    : [];
}

function subjectLabel(version: PolicyVersion): string {
  return version.scope === "project" ? "the project rule book" : `the rule book of ${version.subjectId}`;
}

/** Appends the amendment decision of a written or promoted version; returns its id (null when the log is unavailable). */
export async function recordAmendment(version: PolicyVersion, actorKeyId: string | null, at: number, note: string): Promise<string | null> {
  const draft: PolicyDecisionDraft = {
    id: newDecisionIdHex(),
    at: new Date(at).toISOString(),
    stage: "amendment",
    outcome: version.status === "pending" ? "confirm" : "allow",
    projectId: projectScope(version.projectId),
    keyId: version.scope === "key" ? version.subjectId : null,
    actorKeyId,
    dryRun: false,
    chain: versionLink(version),
    violations: [],
    triggers: [],
    warnings: version.loosened.length > 0 ? [`Loosened: ${version.loosened.slice(0, 20).join(", ")}.`] : [],
    requestDigest: `sha256:${sha256Hex(canonicalJson({ document: version.document, version: version.version }))}`,
    title: `${note} (${subjectLabel(version)}, version ${version.version})`.slice(0, 200),
  };
  try {
    return (await decisionStore().append(draft)).id;
  } catch (error) {
    console.warn("[platform] amendment decision not recorded:", error instanceof Error ? error.message : error);
    return null;
  }
}

/** `policy.amended` for a version now in force (or a removal now in effect). */
export async function announceAmended(version: PolicyVersion, actorKeyId: string | null, at: number): Promise<void> {
  const decisionId = await recordAmendment(version, actorKeyId, at, version.document ? "Rule book in force" : "Rule book removed");
  publishPolicyEvent("policy.amended", {
    projectId: projectScope(version.projectId),
    keyId: version.scope === "key" ? version.subjectId : null,
    scope: version.scope,
    version: version.version,
    hash: version.hash ?? "removed",
    decisionId: decisionId ?? "",
  });
}

/** `policy.amendment_pending` for a loosening version waiting its delay. */
export async function announcePending(version: PolicyVersion, actorKeyId: string, at: number): Promise<void> {
  const decisionId = await recordAmendment(version, actorKeyId, at, `Loosening pending until ${version.activatesAt ?? "?"}`);
  publishPolicyEvent("policy.amendment_pending", {
    projectId: projectScope(version.projectId),
    keyId: version.scope === "key" ? version.subjectId : null,
    scope: version.scope,
    version: version.version,
    activatesAt: version.activatesAt ?? new Date(at).toISOString(),
    loosened: [...version.loosened],
    decisionId: decisionId ?? "",
  });
}

/** Lazy and background promotions (never blocks the caller; failures are logged). */
export function announcePromotions(versions: readonly PolicyVersion[], at = Date.now()): void {
  for (const version of versions) {
    void announceAmended(version, null, at).catch((error: unknown) => {
      console.warn("[platform] policy promotion announcement failed:", error instanceof Error ? error.message : error);
    });
  }
}

/** A key decision (creation, revocation) in the project's log. */
export async function recordKeyDecision(input: {
  readonly projectId: string;
  readonly keyId: string;
  readonly actorKeyId: string | null;
  readonly title: string;
  readonly at: number;
}): Promise<string | null> {
  try {
    const decision = await decisionStore().append({
      id: newDecisionIdHex(),
      at: new Date(input.at).toISOString(),
      stage: "key",
      outcome: "observed",
      projectId: projectScope(input.projectId),
      keyId: input.keyId,
      actorKeyId: input.actorKeyId,
      dryRun: false,
      chain: [],
      violations: [],
      triggers: [],
      warnings: [],
      requestDigest: `sha256:${sha256Hex(canonicalJson({ key: input.keyId, title: input.title }))}`,
      title: input.title.slice(0, 200),
    });
    return decision.id;
  } catch (error) {
    console.warn("[platform] key decision not recorded:", error instanceof Error ? error.message : error);
    return null;
  }
}
