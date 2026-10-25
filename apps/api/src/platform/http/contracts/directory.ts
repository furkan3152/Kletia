/**
 * The engine's ContractDirectory and contract usage.
 */
import {
  CONTRACT_ID_PATTERN,
  deniedTargetReason,
  type NetworkKey,
} from "@kletia/core";
import { PlatformError } from "../../errors.js";
import {
  configureContractDirectory,
  contractDirectory,
  type ActionTransport,
  type ContractDirectory,
  type ContractPhrase,
  type RegisteredContract,
} from "../../index.js";
import { apiKeyStore, keyLive, loadOperatorKeys } from "../auth.js";
import {
  configuredDenylist,
  contractsEnabled,
  keyDailyMaxUsd,
} from "../contractChecks.js";
import { clock, iso } from "./events.js";
import {
  assertContractsEnabled,
  type ContractEntry,
  type ContractRecord,
  usedRevision,
} from "./records.js";
import { contractStore, settle, suspendContract } from "./lifecycle.js";
import { directoryTransport } from "./validation.js";
import { registeredContract } from "./handlers.js";

interface ContractKeyScope {
  readonly projectId: string | null;
}

/**
 * Fresh key and lineage state (no cache): capability-based prepares, such as
 * an embed intent or a session, must also stop after a revocation or an
 * expiry. Operator keys have no project; unknown keys are not live.
 */
async function liveContractScope(keyId: string): Promise<ContractKeyScope | null> {
  if ([...loadOperatorKeys().values()].some((key) => key.id === keyId)) return { projectId: null };
  const keys = apiKeyStore();
  const key = await keys.findById(keyId);
  const now = Date.now();
  if (!key || !keyLive(key, now)) return null;
  const lineage = key.lineage ?? [];
  if (lineage.length > 0) {
    const ancestors = new Map((await keys.findMany(lineage)).map((ancestor) => [ancestor.id, ancestor]));
    const live = lineage.every((id) => {
      const ancestor = ancestors.get(id);
      return ancestor !== undefined && ancestor.projectId === key.projectId && keyLive(ancestor, now);
    });
    if (!live) return null;
  }
  return { projectId: key.projectId };
}

type ContractScopeReader = (keyId: string) => Promise<ContractKeyScope | null>;

/**
 * Whether `ownerKeyId` may use the registration: its owner (in the same
 * project), or a key of the registration's project when it is
 * project-visible and its owner is still live.
 */
async function ownerUsable(record: ContractRecord, ownerKeyId: string, scopeOf: ContractScopeReader = liveContractScope): Promise<boolean> {
  if (record.status === "deleted") return false;
  const caller = await scopeOf(ownerKeyId);
  if (!caller) return false;
  if (record.ownerKeyId === ownerKeyId) return caller.projectId === record.projectId;
  if (record.visibility !== "project" || record.projectId === null || caller.projectId !== record.projectId) return false;
  // A revoked or expired owner key takes its registrations with it (also for project keys).
  const owner = await scopeOf(record.ownerKeyId);
  return owner !== null && owner.projectId === record.projectId;
}

async function usableEntries(ownerKeyId: string): Promise<ContractEntry[]> {
  // Share fresh reads within this one operation, without a TTL that could keep revoked keys usable.
  const scopes = new Map<string, Promise<ContractKeyScope | null>>();
  const scopeOf: ContractScopeReader = (id) => {
    let pending = scopes.get(id);
    if (!pending) {
      pending = liveContractScope(id);
      scopes.set(id, pending);
    }
    return pending;
  };
  const caller = await scopeOf(ownerKeyId);
  if (!caller) return [];
  const out: ContractEntry[] = [];
  for (const raw of await contractStore().listVisible(ownerKeyId, caller.projectId)) {
    if (await ownerUsable(raw.record, ownerKeyId, scopeOf)) out.push(await settle(raw));
  }
  return out;
}

function today(): string {
  return iso(clock()).slice(0, 10);
}

/** The `ContractDirectory` the engine plans, prepares and verifies with. */
export function createContractDirectory(): ContractDirectory {
  return {
    async resolve(ownerKeyId: string, reference: string, network?: NetworkKey): Promise<RegisteredContract | null> {
      assertContractsEnabled();
      const wanted = reference.trim();
      if (CONTRACT_ID_PATTERN.test(wanted)) {
        const raw = await contractStore().get(wanted);
        if (!raw || !(await ownerUsable(raw.record, ownerKeyId))) return null;
        return registeredContract(await settle(raw));
      }
      const alias = wanted.toLowerCase().replace(/\s+/gu, " ");
      const matches = (await usableEntries(ownerKeyId)).filter((entry) => {
        if (network && entry.record.network !== network) return false;
        return usedRevision(entry).definition.actions.some((action) => (action.phrases?.aliases ?? []).includes(alias));
      });
      // Ambiguous aliases resolve to nothing; the grammar disambiguates by network first.
      return matches.length === 1 && matches[0] ? registeredContract(matches[0]) : null;
    },

    async phrases(ownerKeyId: string): Promise<readonly ContractPhrase[]> {
      if (!contractsEnabled()) return [];
      const out: ContractPhrase[] = [];
      for (const entry of await usableEntries(ownerKeyId)) {
        for (const action of usedRevision(entry).definition.actions) {
          if (!action.phrases || action.phrases.verbs.length === 0) continue;
          out.push({
            contract: entry.record.id,
            entry: action.id,
            network: entry.record.network,
            vm: entry.record.vm,
            verbs: action.phrases.verbs,
            aliases: action.phrases.aliases,
            spends: action.input !== undefined,
          });
        }
      }
      return out;
    },

    async current(id: string): Promise<RegisteredContract | null> {
      if (!CONTRACT_ID_PATTERN.test(id)) return null;
      const raw = await contractStore().get(id);
      if (!raw || raw.record.status === "deleted") return null;
      return registeredContract(await settle(raw));
    },

    async usableBy(id: string, ownerKeyId: string): Promise<boolean> {
      assertContractsEnabled();
      if (!CONTRACT_ID_PATTERN.test(id)) return false;
      const raw = await contractStore().get(id);
      return raw !== null && (await ownerUsable(raw.record, ownerKeyId));
    },

    denied(network: NetworkKey, target: string): string | null {
      return deniedTargetReason(network, target, configuredDenylist());
    },

    async reportAnomaly(id: string, reason: "pins_changed" | "outcome_mismatch" | "program_changed", detail: string): Promise<void> {
      await suspendContract(id, reason, detail);
    },

    async recordSpend(ownerKeyId: string, usd: number): Promise<void> {
      assertContractsEnabled();
      if (!Number.isFinite(usd) || usd < 0) return;
      const cap = keyDailyMaxUsd();
      if (!(await contractStore().addSpend(ownerKeyId, today(), usd, cap))) {
        throw new PlatformError(
          "CONTRACT_SPEND_LIMIT",
          `This key reached its daily notional cap of $${cap.toLocaleString("en-US")} for custom contract steps (UTC day). Retry tomorrow or ask the operator for a higher cap.`,
          422,
        );
      }
    },

    get actionTransport(): ActionTransport {
      return directoryTransport();
    },
  };
}

/**
 * Installs the directory into the engine (called by createPlatformRouter).
 * Idempotent, and it never replaces a directory an embedder or a test
 * installed (`configurePlatform({ contracts })`).
 */
export function installContractDirectory(): void {
  if (contractDirectory() !== null) return;
  configureContractDirectory(createContractDirectory());
}

/* ================================================================== usage */

export interface ContractUsage {
  readonly registered: number;
  readonly suspended: number;
  readonly preparedToday: number;
  readonly notionalTodayUsd: number;
}

/** The `contracts` block of GET /v1/usage. */
export async function contractUsage(keyId: string): Promise<ContractUsage> {
  const [counts, spend] = await Promise.all([contractStore().counts(keyId), contractStore().spend(keyId, today())]);
  return { registered: counts.registered, suspended: counts.suspended, preparedToday: spend.prepared, notionalTodayUsd: Math.round(spend.usd * 100) / 100 };
}
