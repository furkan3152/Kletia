/**
 * GET /deployments/export: verified records grouped by network, ready for
 * the lead to pin in a release (pinned contracts are already in the repo).
 */
import {
  ADMIN_CONTRACTS,
  ADMIN_EXPORT_SCHEMA,
  explorerAddressUrl,
  type AdminDeploymentRecord,
  type AdminEvmNetwork,
  type AdminExport,
  type AdminExportEntry,
} from "@kletia/core";
import { getArtifact } from "./contract-artifacts/index.js";

export function buildExport(records: readonly AdminDeploymentRecord[], exportedBy: string, exportedAt: Date, apiCommit: string | null): AdminExport {
  const networks: Partial<Record<AdminEvmNetwork, AdminExportEntry[]>> = {};
  const verified = records.filter((record) => record.status === "verified")
    .sort((a, b) => a.network.localeCompare(b.network) || a.createdAt.localeCompare(b.createdAt));
  for (const record of verified) {
    const artifact = getArtifact(record.artifactId);
    const entry: AdminExportEntry = {
      contractId: record.contractId, ...(record.instance ? { instance: record.instance } : {}),
      contractName: ADMIN_CONTRACTS[record.contractId].name, address: record.address, txHash: record.txHash, block: record.block,
      deployer: record.deployer, constructorArgs: record.constructorArgs, onchainCodehash: record.onchainCodehash,
      artifactMaskedRuntimeHash: record.artifactMaskedRuntimeHash,
      compiler: artifact?.compiler ?? { solc: "unknown", optimizer: false, runs: 0, evmVersion: "unknown" },
      explorerUrl: explorerAddressUrl(record.network, record.address), status: "verified",
    };
    (networks[record.network] ??= []).push(entry);
  }
  return { schemaVersion: ADMIN_EXPORT_SCHEMA, exportedAt: exportedAt.toISOString(), exportedBy, apiCommit, networks };
}
