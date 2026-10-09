/**
 * The Rule Book chain of an owner key (policy design §2, §4.2), read fresh
 * from the key store and the rule book store for every plan and prepare:
 * the project rule book, each lineage key's, then the key's own. Agent keys
 * evaluate absent fields with agent defaults (and no rule book as the
 * observer). The owner and every ancestor must be active and unexpired
 * (`keyActive`), whatever the 15 s authentication cache says.
 *
 * Operator keys (configuration, not stored) are governed by nothing.
 */
import type { PolicyChainLink } from "@kletia/core";
import type { PolicyChainLevel, PolicyChainSnapshot, PolicyChainSource } from "../../index.js";
import { apiKeyStore, keyKindOf, keyLive, type ApiKeyRecord } from "../auth.js";
import type { AuthContext } from "../context.js";
import { announcePromotions } from "./announce.js";
import { policyStore, projectScope, subjectKey, type PolicyScope } from "./store.js";

const OPERATOR_KEY_ID = /^op_[0-9a-f]{16}$/u;

export function isOperatorKeyId(id: string): boolean {
  return OPERATOR_KEY_ID.test(id);
}

export interface KeyChain extends PolicyChainSnapshot {
  /** Owner record (null for operator keys). */
  readonly record: ApiKeyRecord | null;
  /** Raw project id. */
  readonly rawProjectId: string;
}

/** Fresh chain of an owner key; undefined when the key is unknown. */
export async function readKeyChain(ownerKeyId: string, now = Date.now()): Promise<KeyChain | undefined> {
  if (isOperatorKeyId(ownerKeyId)) {
    return { projectId: projectScope(ownerKeyId), rawProjectId: ownerKeyId, ownerKeyId, lineage: [], keyActive: true, levels: [], record: null };
  }
  const keys = apiKeyStore();
  const record = await keys.findById(ownerKeyId);
  if (!record) return undefined;
  const lineage = [...(record.lineage ?? [])];
  const ancestors = await keys.findMany(lineage);
  const byId = new Map(ancestors.map((ancestor) => [ancestor.id, ancestor]));
  const keyActive = keyLive(record, now) && lineage.every((id) => {
    const ancestor = byId.get(id);
    return ancestor !== undefined && ancestor.projectId === record.projectId && keyLive(ancestor, now);
  });
  const rawProjectId = record.projectId;
  const subjects: { scope: PolicyScope; subjectId: string; projectId: string }[] = [
    { scope: "project", subjectId: rawProjectId, projectId: rawProjectId },
    ...[...lineage, ownerKeyId].map((id) => ({ scope: "key" as const, subjectId: id, projectId: rawProjectId })),
  ];
  const { active, promoted } = await policyStore().activeMany(subjects, now);
  if (promoted.length > 0) announcePromotions(promoted);
  const level = (scope: PolicyScope, subjectId: string, agent: boolean): PolicyChainLevel => {
    const version = active.get(subjectKey(scope, subjectId));
    return {
      scope,
      id: scope === "project" ? projectScope(subjectId) : subjectId,
      defaults: agent ? "agent" : "project",
      policy: version?.document ?? null,
      version: version?.document ? version.version : null,
      hash: version?.document ? version.hash : null,
    };
  };
  const levels: PolicyChainLevel[] = [
    level("project", rawProjectId, false),
    ...lineage.map((id) => level("key", id, keyKindOf(byId.get(id) ?? { kind: "project" }) === "agent")),
    level("key", ownerKeyId, keyKindOf(record) === "agent"),
  ];
  return { projectId: projectScope(rawProjectId), rawProjectId, ownerKeyId, lineage, keyActive, levels, record };
}

/** The `PolicyChainSource` port of the reference gate. */
export const keyChainSource: PolicyChainSource = {
  chain: (ownerKeyId) => readKeyChain(ownerKeyId),
};

/** Heads (scope, id, version, hash) of the chain's rule books, root first. */
export function chainLinks(levels: readonly PolicyChainLevel[]): PolicyChainLink[] {
  return levels.flatMap((level) => (level.version !== null && level.hash !== null ? [{ scope: level.scope, id: level.id, version: level.version, hash: level.hash }] : []));
}

/**
 * Key ids a caller may see and act on: project keys see the whole project,
 * agent keys themselves and their descendants.
 */
export async function subtreeOf(auth: AuthContext): Promise<{ readonly projectId: string; readonly keyIds: readonly string[] | null; readonly records: readonly ApiKeyRecord[] }> {
  const projectId = auth.projectId ?? auth.keyId ?? "";
  const records = auth.projectId ? await apiKeyStore().listByProject(auth.projectId) : [];
  if (auth.keyKind !== "agent" || !auth.keyId) return { projectId, keyIds: null, records };
  const caller = auth.keyId;
  const mine = records.filter((record) => record.id === caller || (record.lineage ?? []).includes(caller));
  return { projectId, keyIds: mine.map((record) => record.id), records: mine };
}

/** True when `keyId` is the caller or in its subtree (project keys: any key of the project). */
export async function inSubtree(auth: AuthContext, keyId: string): Promise<ApiKeyRecord | null> {
  if (!auth.projectId) return null;
  const record = await apiKeyStore().findById(keyId);
  if (!record || record.projectId !== auth.projectId) return null;
  if (auth.keyKind !== "agent") return record;
  return record.id === auth.keyId || (record.lineage ?? []).includes(auth.keyId ?? "") ? record : null;
}
