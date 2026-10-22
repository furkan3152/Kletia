/**
 * Catalog lookups shared by the admin routes: targets, pinned deployments,
 * recorded deployments and dependency resolution.
 */
import {
  ADMIN_CONTRACTS,
  ADMIN_DEPLOY_TARGETS,
  ADMIN_EVM_NETWORKS,
  ADMIN_NETWORK_CONSTANTS,
  ADMIN_PINNED_DEPLOYMENTS,
  CHAINS,
  type AdminContractId,
  type AdminContractSpec,
  type AdminDeployTarget,
  type AdminDeploymentRecord,
  type AdminEvmNetwork,
  type AdminNetworkConstant,
  type AdminNetworkProfile,
  type AdminPinnedDeployment,
} from "@kletia/core";
import type { AdminStore } from "./store/types.js";

export function isAdminNetwork(value: unknown): value is AdminEvmNetwork {
  return typeof value === "string" && (ADMIN_EVM_NETWORKS as readonly string[]).includes(value);
}

export function chainIdOf(network: AdminEvmNetwork): number {
  return CHAINS[network].evmChainId as number;
}

export function targetById(id: string): AdminDeployTarget | null {
  return ADMIN_DEPLOY_TARGETS.find((target) => target.id === id) ?? null;
}

export function specOf(contractId: AdminContractId): AdminContractSpec {
  return ADMIN_CONTRACTS[contractId];
}

export function pinnedFor(network: AdminEvmNetwork, contractId: AdminContractId, instance?: string): AdminPinnedDeployment[] {
  return ADMIN_PINNED_DEPLOYMENTS.filter((entry) =>
    entry.network === network && entry.contractId === contractId && (instance === undefined || entry.instance === instance));
}

export function pinnedByAddress(network: AdminEvmNetwork, address: string): AdminPinnedDeployment | null {
  const lower = address.toLowerCase();
  return ADMIN_PINNED_DEPLOYMENTS.find((entry) => entry.network === network && entry.address.toLowerCase() === lower) ?? null;
}

/** A network's profile before an admin saves one: the catalog's default roles. */
export function profileDefaults(network: AdminEvmNetwork): AdminNetworkProfile {
  const roles = ADMIN_NETWORK_CONSTANTS[network].defaultRoles ?? {};
  return {
    network, owner: roles.owner ?? null, guardian: roles.guardian ?? null, treasury: roles.treasury ?? null,
    eoaOwnerAcknowledged: false, updatedBy: null, updatedAt: null,
  };
}

/** The owner configured for a network: the saved profile's, else the default role. */
export async function profileOwner(store: AdminStore, network: AdminEvmNetwork): Promise<string | null> {
  const saved = (await store.listProfiles()).find((profile) => profile.network === network);
  return (saved ?? profileDefaults(network)).owner;
}

export function networkConstant(network: AdminEvmNetwork, key: AdminNetworkConstant): string | null {
  return ADMIN_NETWORK_CONSTANTS[network][key] ?? null;
}

/** The newest verified record of a contract on a network (optionally one instance). */
export async function newestVerified(store: AdminStore, network: AdminEvmNetwork, contractId: AdminContractId, instance?: string): Promise<AdminDeploymentRecord | null> {
  const records = await store.listDeployments({ network, status: "verified" });
  return records.find((record) => record.contractId === contractId && (instance === undefined || record.instance === instance)) ?? null;
}

/** Address a dependency resolves to: newest verified record, else the pinned address. */
export async function resolveDependencyAddress(store: AdminStore, network: AdminEvmNetwork, contractId: AdminContractId, instance?: string): Promise<string | null> {
  const record = await newestVerified(store, network, contractId, instance);
  if (record) return record.address;
  return pinnedFor(network, contractId, instance)[0]?.address ?? null;
}

/** Every address a dependency may legitimately take: all verified records and pinned addresses. */
export async function dependencyCandidates(store: AdminStore, network: AdminEvmNetwork, contractId: AdminContractId, instance?: string): Promise<string[]> {
  const records = await store.listDeployments({ network, status: "verified" });
  return [
    ...records.filter((record) => record.contractId === contractId && (instance === undefined || record.instance === instance)).map((record) => record.address),
    ...pinnedFor(network, contractId, instance).map((entry) => entry.address),
  ];
}

/** True when a target has a verified record or a pinned address (dependency gate). */
export async function targetSatisfied(store: AdminStore, targetId: string): Promise<boolean> {
  const target = targetById(targetId);
  if (!target) return false;
  return (await resolveDependencyAddress(store, target.network, target.contractId, target.instance)) !== null;
}

export interface KnownContract {
  readonly network: AdminEvmNetwork;
  readonly address: string;
  readonly contractId: AdminContractId;
  readonly pinned: AdminPinnedDeployment | null;
  readonly record: AdminDeploymentRecord | null;
  readonly recordKey: string;
}

/**
 * A pinned or recorded Kletia contract at `address` on `network`, or null
 * (arbitrary addresses are never accepted; archived and foreign records are
 * not targets for actions or Safe proposals).
 */
export async function findKnownContract(store: AdminStore, network: AdminEvmNetwork, address: string): Promise<KnownContract | null> {
  const pinned = pinnedByAddress(network, address);
  if (pinned) return { network, address: pinned.address, contractId: pinned.contractId, pinned, record: null, recordKey: `pinned:${network}:${pinned.address}` };
  const record = await store.findDeploymentByAddress(chainIdOf(network), address);
  if (record && record.status !== "archived" && record.status !== "foreign") return { network, address: record.address, contractId: record.contractId, pinned: null, record, recordKey: record.id };
  return null;
}

/** Resolves `pinned:<network>:<address>` or a record id. */
export async function resolveRecordKey(store: AdminStore, recordKey: string): Promise<KnownContract | null> {
  const pinnedMatch = /^pinned:([a-z-]+):(0x[0-9a-fA-F]{40})$/u.exec(recordKey);
  if (pinnedMatch) {
    const network = pinnedMatch[1];
    if (!isAdminNetwork(network)) return null;
    const pinned = pinnedByAddress(network, pinnedMatch[2] as string);
    return pinned ? { network, address: pinned.address, contractId: pinned.contractId, pinned, record: null, recordKey: `pinned:${network}:${pinned.address}` } : null;
  }
  if (!/^dep_[0-9a-f]{24}$/u.test(recordKey)) return null;
  const record = await store.getDeployment(recordKey);
  return record ? { network: record.network, address: record.address, contractId: record.contractId, pinned: null, record, recordKey: record.id } : null;
}

/** All pinned and non-archived recorded contracts (optionally on one network). */
export async function listKnownContracts(store: AdminStore, network?: AdminEvmNetwork): Promise<KnownContract[]> {
  const pinned: KnownContract[] = ADMIN_PINNED_DEPLOYMENTS
    .filter((entry) => !network || entry.network === network)
    .map((entry) => ({ network: entry.network, address: entry.address, contractId: entry.contractId, pinned: entry, record: null, recordKey: `pinned:${entry.network}:${entry.address}` }));
  const records = (await store.listDeployments(network ? { network } : {}))
    .filter((record) => record.status === "verified")
    .map((record) => ({ network: record.network, address: record.address, contractId: record.contractId, pinned: null, record, recordKey: record.id }));
  return [...pinned, ...records];
}
