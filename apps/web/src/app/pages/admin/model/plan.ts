/**
 * The deploy checklist of one network: the catalog's targets in `order`,
 * each with a status chip, what it waits for and whether the panel offers
 * a deploy. Solana networks carry no Kletia programs and get the empty
 * state. Pure.
 */
import { CHAINS, explorerAddressUrl, explorerTxUrl } from "@kletia/core";

import type {
  AdminCatalog,
  AdminContractSpec,
  AdminDeployTarget,
  AdminDeploymentRecord,
  AdminEvmNetwork,
  AdminPanelNetwork,
  AdminPinnedDeployment,
} from "./types.ts";

export const ADMIN_EVM_NETWORKS: readonly AdminEvmNetwork[] = ["base", "arbitrum", "ethereum", "optimism", "polygon", "arc", "arbitrum-sepolia"];
export const ADMIN_NO_PROGRAM_NETWORKS: readonly AdminPanelNetwork[] = ["solana", "solana-devnet"];
/** Every network tab of the panel, EVM first. */
export const ADMIN_PANEL_NETWORKS: readonly AdminPanelNetwork[] = [...ADMIN_EVM_NETWORKS, ...ADMIN_NO_PROGRAM_NETWORKS];

export const NO_PROGRAMS_TEXT = "No Kletia programs. Nothing to deploy.";

export function isEvmNetwork(network: string): network is AdminEvmNetwork {
  return (ADMIN_EVM_NETWORKS as readonly string[]).includes(network);
}

export function networkName(network: AdminPanelNetwork): string {
  return CHAINS[network]?.name ?? network;
}

export function isTestnet(network: AdminPanelNetwork): boolean {
  return CHAINS[network]?.environment === "testnet";
}

export function chainIdOf(network: AdminEvmNetwork): number {
  const id = CHAINS[network]?.evmChainId;
  if (typeof id !== "number") throw new Error(`No EVM chain id for ${network}.`);
  return id;
}

export function networkForChainId(chainId: number | null | undefined): AdminEvmNetwork | null {
  if (typeof chainId !== "number") return null;
  return ADMIN_EVM_NETWORKS.find((network) => CHAINS[network]?.evmChainId === chainId) ?? null;
}

export function addressUrl(network: AdminEvmNetwork, address: string): string {
  return explorerAddressUrl(network, address);
}

export function txUrl(network: AdminEvmNetwork, hash: string): string {
  return explorerTxUrl(network, hash);
}

export type PlanChip = "pinned" | "verified" | "failed" | "ready" | "waiting" | "not-applicable" | "quarantined" | "legacy";

export const CHIP_LABELS: Readonly<Record<PlanChip, string>> = {
  pinned: "Pinned",
  verified: "Verified (new)",
  failed: "Verification failed",
  ready: "Ready",
  waiting: "Waiting",
  "not-applicable": "Not applicable",
  quarantined: "Quarantined",
  legacy: "Legacy",
};

export interface PlanRow {
  readonly target: AdminDeployTarget;
  readonly spec: AdminContractSpec | null;
  readonly title: string;
  readonly chip: PlanChip;
  /** One line under the title: the reason, what it waits for, or the live address. */
  readonly detail: string;
  readonly waitingFor: readonly string[];
  readonly record: AdminDeploymentRecord | null;
  readonly pinned: AdminPinnedDeployment | null;
  /** The deploy button: "deploy", "replace" (a pinned or verified target), or null. */
  readonly deploy: "deploy" | "replace" | null;
}

export type NetworkPlan =
  | { readonly kind: "evm"; readonly network: AdminEvmNetwork; readonly testnet: boolean; readonly rows: readonly PlanRow[] }
  | { readonly kind: "no-programs"; readonly network: AdminPanelNetwork; readonly message: string };

function sameTarget(target: AdminDeployTarget, item: { network: string; contractId: string; instance?: string }): boolean {
  return item.network === target.network && item.contractId === target.contractId && (item.instance ?? undefined) === (target.instance ?? undefined);
}

function newest<T extends { createdAt: string }>(items: readonly T[]): T | null {
  return [...items].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] ?? null;
}

/** A target is satisfied when it has a verified record or a pinned (non-legacy) address. */
export function targetSatisfied(
  targetId: string,
  catalog: Pick<AdminCatalog, "targets" | "pinned">,
  records: readonly AdminDeploymentRecord[],
): boolean {
  const target = catalog.targets.find((item) => item.id === targetId);
  if (!target) return false;
  if (records.some((record) => record.targetId === targetId && record.status === "verified")) return true;
  return catalog.pinned.some((pin) => sameTarget(target, pin) && pin.lifecycle !== "legacy");
}

export function targetTitle(target: AdminDeployTarget, spec: AdminContractSpec | null): string {
  const name = spec?.name ?? target.contractId;
  return target.instance ? `${name} (${target.instance})` : name;
}

export function planFor(network: AdminPanelNetwork, catalog: AdminCatalog, records: readonly AdminDeploymentRecord[]): NetworkPlan {
  if (!isEvmNetwork(network)) return { kind: "no-programs", network, message: NO_PROGRAMS_TEXT };
  const targets = catalog.targets.filter((target) => target.network === network).sort((a, b) => a.order - b.order);
  const rows = targets.map((target): PlanRow => {
    const spec = catalog.contracts[target.contractId] ?? null;
    const title = targetTitle(target, spec);
    const own = records.filter((record) => record.targetId === target.id && record.status !== "archived");
    const verified = newest(own.filter((record) => record.status === "verified"));
    const failed = newest(own.filter((record) => record.status === "verification_failed"));
    const pinned = catalog.pinned.find((pin) => sameTarget(target, pin)) ?? null;
    const base = { target, spec, title, record: verified ?? failed, pinned, waitingFor: [] as string[] };
    if (target.status === "not-applicable") return { ...base, chip: "not-applicable", detail: target.reason, deploy: null };
    if (target.status === "quarantined") return { ...base, chip: "quarantined", detail: target.reason, deploy: null };
    if (target.status === "legacy") {
      return { ...base, chip: "legacy", detail: pinned ? `Read only. Live at ${pinned.address}.` : target.reason, deploy: null };
    }
    if (verified) return { ...base, record: verified, chip: "verified", detail: `Verified at ${verified.address}. Not wired into the product until the lead pins it.`, deploy: "replace" };
    if (target.status === "pinned") {
      return { ...base, chip: "pinned", detail: pinned ? `Live at ${pinned.address}.` : target.reason, deploy: "replace" };
    }
    const waitingFor = target.dependsOn.filter((id) => !targetSatisfied(id, catalog, records));
    if (waitingFor.length > 0) {
      const names = waitingFor.map((id) => {
        const dependency = catalog.targets.find((item) => item.id === id);
        return dependency ? targetTitle(dependency, catalog.contracts[dependency.contractId] ?? null) : id;
      });
      return { ...base, chip: "waiting", waitingFor, detail: `Waiting for ${names.join(", ")}.`, deploy: null };
    }
    if (failed) return { ...base, chip: "failed", detail: "The last recorded deployment failed verification. Read its checks, then deploy again or reverify.", deploy: "deploy" };
    return { ...base, chip: "ready", detail: target.reason || "Ready to deploy with the admin wallet.", deploy: "deploy" };
  });
  return { kind: "evm", network, testnet: isTestnet(network), rows };
}

/** Network × contract matrix cell letters. */
export type MatrixCell = "P" | "D" | "Q" | "L" | "V" | "-";

export function matrixCell(chip: PlanChip): MatrixCell {
  switch (chip) {
    case "pinned":
      return "P";
    case "verified":
      return "V";
    case "ready":
    case "waiting":
    case "failed":
      return "D";
    case "quarantined":
      return "Q";
    case "legacy":
      return "L";
    default:
      return "-";
  }
}

export interface MatrixRow {
  readonly contractId: string;
  readonly title: string;
  readonly cells: Readonly<Record<AdminEvmNetwork, MatrixCell>>;
}

/** Every catalog contract that has a target somewhere, with one cell per EVM network. */
export function deploymentMatrix(catalog: AdminCatalog, records: readonly AdminDeploymentRecord[]): MatrixRow[] {
  const plans = ADMIN_EVM_NETWORKS.map((network) => planFor(network, catalog, records));
  const keys = new Map<string, string>();
  for (const target of [...catalog.targets].sort((a, b) => a.order - b.order)) {
    const key = target.instance ? `${target.contractId}:${target.instance}` : target.contractId;
    if (!keys.has(key)) keys.set(key, targetTitle(target, catalog.contracts[target.contractId] ?? null));
  }
  return [...keys.entries()].map(([key, title]) => {
    const cells = {} as Record<AdminEvmNetwork, MatrixCell>;
    for (const plan of plans) {
      if (plan.kind !== "evm") continue;
      const row = plan.rows.find((item) => (item.target.instance ? `${item.target.contractId}:${item.target.instance}` : item.target.contractId) === key);
      cells[plan.network] = row ? matrixCell(row.chip) : "-";
    }
    return { contractId: key, title, cells };
  });
}
