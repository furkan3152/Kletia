/**
 * Contract directory hook (bring your own contract).
 *
 * The engine never reads the contract registry itself: the HTTP layer
 * installs a `ContractDirectory` (its memory / Postgres store) with
 * `configureContractDirectory`, exactly like the recipient name resolvers,
 * and tests substitute one through `configurePlatform({ contracts })`.
 * Without a directory, call and action steps fail with CONTRACTS_DISABLED.
 *
 * Scoping is the directory's job and fails closed: `resolve` and `phrases`
 * only ever return registrations the given owner key may use, and a foreign
 * id is indistinguishable from an unknown one (null).
 */
import type {
  ContractAnomalyReason,
  ContractDefinition,
  ContractVerification,
  EvmContractPins,
  NetworkKey,
  SolanaProgramPin,
} from "@kletia/core";

/** One registration as the engine sees it: the active revision (or the pending first one). */
export interface RegisteredContract {
  readonly id: string;
  readonly ownerKeyId: string;
  readonly projectId: string | null;
  readonly status: "pending" | "active" | "suspended";
  /** Null while the first revision waits for activation. */
  readonly activeRevision: number | null;
  readonly activatesAt: string | null;
  /** Normalised definition (validateContractDefinition) of the active revision. */
  readonly definition: ContractDefinition;
  /** contractDefinitionHash(definition). */
  readonly definitionHash: string;
  /** EVM: EvmContractPins of the target (and extra addresses); Solana: one pin per allowlisted program. */
  readonly pins: EvmContractPins | readonly SolanaProgramPin[];
  readonly verification: ContractVerification;
  /** When the registration was created (review "registered at"); optional for directories that do not track it. */
  readonly createdAt?: string;
}

/** Natural-language phrases of one entry, for the grammar. */
export interface ContractPhrase {
  readonly contract: string;
  readonly entry: string;
  readonly network: NetworkKey;
  readonly vm: "evm" | "svm";
  readonly verbs: readonly string[];
  readonly aliases: readonly string[];
  /** True when the entry spends an input token (an amount is required). */
  readonly spends: boolean;
}

/** HTTP transport for Solana Actions endpoints (SSRF-guarded, bounded, no redirects, no cookies). */
export interface ActionTransport {
  get(url: string): Promise<{ status: number; headers: Record<string, string>; json: unknown }>;
  post(url: string, body: unknown): Promise<{ status: number; headers: Record<string, string>; json: unknown }>;
}

export interface ContractDirectory {
  /** A registration `ownerKeyId` may use, by id or alias; null otherwise (never reveals foreign ids). */
  resolve(ownerKeyId: string, reference: string, network?: NetworkKey): Promise<RegisteredContract | null>;
  /** Phrases of every registration `ownerKeyId` may use (grammar). */
  phrases(ownerKeyId: string): Promise<readonly ContractPhrase[]>;
  /** Fresh state for prepare / verify, regardless of owner. */
  current(id: string): Promise<RegisteredContract | null>;
  /** Whether `ownerKeyId` may use registration `id` (prepare-time owner check). */
  usableBy(id: string, ownerKeyId: string): Promise<boolean>;
  /** Built-in + configured deny lists: why `target` may not be called on `network`, or null. */
  denied(network: NetworkKey, target: string): string | null;
  /** Suspend after a pin change / outcome mismatch (idempotent; emits contract.suspended). */
  reportAnomaly(id: string, reason: ContractAnomalyReason, detail: string): Promise<void>;
  /** Records priced notional at prepare; throws CONTRACT_SPEND_LIMIT when over the cap. */
  recordSpend(ownerKeyId: string, usd: number): Promise<void>;
  /** SSRF-guarded transport for Solana Actions. */
  readonly actionTransport: ActionTransport;
}

let installed: ContractDirectory | null = null;

/** Installs (or with null removes) the contract directory the engine plans and prepares with. */
export function configureContractDirectory(directory: ContractDirectory | null): void {
  installed = directory;
}

/** The installed directory, or null when custom contracts are not wired up. */
export function contractDirectory(): ContractDirectory | null {
  return installed;
}

/**
 * Kill switch: `KLETIA_CONTRACTS_ENABLED=false` (or 0/off/no) disables
 * registration, planning and preparing of call/action steps. Verification of
 * already submitted steps continues.
 */
export function contractsEnabled(): boolean {
  const raw = process.env.KLETIA_CONTRACTS_ENABLED?.trim().toLowerCase();
  return !(raw === "false" || raw === "0" || raw === "off" || raw === "no");
}

/** Reports an anomaly without ever failing the caller (verification must not depend on the registry). */
export async function reportContractAnomaly(id: string, reason: ContractAnomalyReason, detail: string): Promise<void> {
  const directory = installed;
  if (!directory) return;
  try {
    await directory.reportAnomaly(id, reason, detail.slice(0, 300));
  } catch (error) {
    console.warn(`[platform] could not suspend contract ${id} (${reason}):`, error instanceof Error ? error.message : error);
  }
}
