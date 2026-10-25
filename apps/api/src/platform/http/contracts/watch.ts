/**
 * Watching registered contracts and domains for changes.
 */
import type {
  ContractPins,
  EvmContractDefinition,
  SolanaActionDefinition,
} from "@kletia/core";
import {
  comparePins,
  contractChecks,
  contractEngine,
} from "../contractChecks.js";
import { clock, iso, nextTimestamp, publish } from "./events.js";
import { type ContractEntry, usedRevision } from "./records.js";
import {
  contractStore,
  mutate,
  needsDomain,
  settle,
  suspendContract,
} from "./lifecycle.js";
import { evmNetwork, solanaNetwork } from "./validation.js";

/* ====================================================== watcher internals */

export interface WatchOutcome {
  readonly id: string;
  readonly result: "unchanged" | "suspended" | "error";
  readonly detail?: string;
}

/** Re-reads one registration's pins (watcher): a difference suspends it. Never throws. */
export async function watchContract(entry: ContractEntry): Promise<WatchOutcome> {
  const { record } = entry;
  const revision = usedRevision(entry);
  try {
    let current: ContractPins;
    if (record.vm === "evm") {
      const definition = revision.definition as EvmContractDefinition;
      const inspection = await contractEngine().inspectEvmContract(evmNetwork(record.network), definition.address, definition.addresses ?? []);
      if (inspection.eip7702 || inspection.codeSize <= 0) {
        await suspendContract(record.id, "pins_changed", inspection.eip7702 ? "now an EIP-7702 delegated account" : "code removed");
        return { id: record.id, result: "suspended", detail: "code removed or delegated" };
      }
      current = inspection.pins;
    } else {
      current = await contractEngine().readSolanaProgramPins(solanaNetwork(record.network), (revision.definition as SolanaActionDefinition).programs);
    }
    const diff = comparePins(revision.pins, current);
    if (diff !== null) {
      await suspendContract(record.id, record.vm === "evm" ? "pins_changed" : "program_changed", diff);
      return { id: record.id, result: "suspended", detail: diff };
    }
    await mutate(record.id, async (fresh) =>
      fresh.record.status === "deleted"
        ? null
        : { record: { ...fresh.record, pinsCheckedAt: iso(clock()), updatedAt: nextTimestamp(fresh.record.updatedAt, clock()) } },
    );
    return { id: record.id, result: "unchanged" };
  } catch (error) {
    return { id: record.id, result: "error", detail: error instanceof Error ? error.message.slice(0, 120) : "check failed" };
  }
}

/** Re-checks the domain file of one registration (watcher, daily). A reserved brand that loses it is suspended. Never throws. */
export async function watchDomain(entry: ContractEntry): Promise<boolean | null> {
  const { record } = entry;
  const definition = usedRevision(entry).definition;
  try {
    const verified = await contractChecks().domain(definition.integrator.website, record.id);
    const domain = { verified, checkedAt: iso(clock()) };
    const result = await mutate(record.id, async (fresh) => {
      if (fresh.record.status === "deleted") return null;
      const lose = needsDomain(usedRevision(fresh).definition) && fresh.record.verification.domain.verified && !verified && fresh.record.status === "active";
      return {
        record: {
          ...fresh.record,
          verification: { ...fresh.record.verification, domain },
          ...(lose ? { status: "suspended" as const, suspendedReason: "domain_unverified" } : {}),
          updatedAt: nextTimestamp(fresh.record.updatedAt, clock()),
        },
      };
    });
    if (result && result.before.record.status !== "suspended" && result.after.record.status === "suspended") {
      publish("contract.suspended", result.after.record, result.after.record.activeRevision ?? result.after.record.revision, "domain_unverified");
    }
    if (result) await settle(result.after);
    return verified;
  } catch {
    return null;
  }
}

/** Registrations due for a pin check (watcher). */
export function contractsToWatch(limit: number): Promise<ContractEntry[]> {
  return contractStore().listForWatch(limit);
}
