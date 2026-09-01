import {
  BASE_FEE,
  Contract,
  StrKey,
  TransactionBuilder,
  rpc,
  scValToNative,
} from "@stellar/stellar-sdk";

import { STELLAR_TESTNET } from "./config.js";
import { observeLiveExecutable } from "./policyRegistryReadiness.js";

export const STELLAR_SOLVER_MARKET_DEPLOYMENT_MANIFEST =
  "contracts/stellar/deployments/testnet/solver-market.v1.json" as const;

export const STELLAR_SOLVER_MARKET_RELEASES = Object.freeze({
  solverBondVault: Object.freeze({
    environmentVariable: "STELLAR_SOLVER_BOND_VAULT_TESTNET_CONTRACT_ID",
    wasmSha256: "413d9273a59c834e70e667fd25b444c9ff2b1b1bf30ca00b5381a4c54b77dddf",
  }),
  routeAuction: Object.freeze({
    environmentVariable: "STELLAR_ROUTE_AUCTION_TESTNET_CONTRACT_ID",
    wasmSha256: "84f95aeedfb048539e441634a4abed5ea94ef5963a19fb1e970840532cca50e2",
  }),
});

type ReleaseKey = keyof typeof STELLAR_SOLVER_MARKET_RELEASES;

function configuredContract(key: ReleaseKey): string {
  return process.env[STELLAR_SOLVER_MARKET_RELEASES[key].environmentVariable]?.trim() || "";
}

function validAddress(value: unknown): value is string {
  const address = String(value ?? "");
  return StrKey.isValidEd25519PublicKey(address) || StrKey.isValidContract(address);
}

async function simulateGetter(contractId: string, method: string): Promise<{
  readonly value: Record<string, unknown>;
  readonly latestLedger: number;
}> {
  const source = process.env.STELLAR_CONTROL_PLANE_READ_SOURCE_ACCOUNT?.trim() || "";
  if (!StrKey.isValidEd25519PublicKey(source)) {
    throw new Error("A funded Stellar Testnet read-source account is required.");
  }
  const server = new rpc.Server(STELLAR_TESTNET.rpcUrl, { timeout: 8_000 });
  const account = await server.getAccount(source);
  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: STELLAR_TESTNET.networkPassphrase,
  })
    .addOperation(new Contract(contractId).call(method))
    .setTimeout(60)
    .build();
  const simulation = await server.simulateTransaction(transaction);
  if (
    !rpc.Api.isSimulationSuccess(simulation) ||
    rpc.Api.isSimulationRestore(simulation) ||
    !simulation.result
  ) {
    throw new Error(`${method} could not be simulated without restoration.`);
  }
  const value = scValToNative(simulation.result.retval) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${method} returned an invalid contract record.`);
  }
  return {
    value: value as Record<string, unknown>,
    latestLedger: simulation.latestLedger,
  };
}

function emptyContracts() {
  return (Object.keys(STELLAR_SOLVER_MARKET_RELEASES) as ReleaseKey[]).map((key) => ({
    key,
    contractId: configuredContract(key) || null,
    expectedWasmSha256: STELLAR_SOLVER_MARKET_RELEASES[key].wasmSha256,
    observedWasmSha256: null,
    observedAtLedger: null,
    ready: false,
  }));
}

export async function readStellarSolverMarketReadiness(
  lane: "production" | "testnet",
) {
  const base = {
    schemaVersion: "kletia_stellar_solver_market_readiness_v1" as const,
    lane,
    sourceReady: true as const,
    productionReady: false as const,
    deploymentManifest: STELLAR_SOLVER_MARKET_DEPLOYMENT_MANIFEST,
    contractDesign: "asset_backed_bond_and_commit_reveal_auction" as const,
    provesForeignExecution: false as const,
    automaticTimeoutSlashing: false as const,
  };
  if (lane !== "testnet") {
    return Object.freeze({
      ...base,
      ready: false,
      status: "mainnet_disabled" as const,
      reason: "The solver market has no reviewed Stellar Mainnet deployment.",
      contracts: emptyContracts(),
      bindings: null,
    });
  }

  const enabled = process.env.STELLAR_SOLVER_MARKET_ENABLED?.trim() === "true";
  const vaultId = configuredContract("solverBondVault");
  const auctionId = configuredContract("routeAuction");
  if (!enabled || !StrKey.isValidContract(vaultId) || !StrKey.isValidContract(auctionId)) {
    return Object.freeze({
      ...base,
      ready: false,
      status: !enabled ? "disabled" as const : "contract_configuration_invalid" as const,
      reason: !enabled
        ? "Solver-market source is present, but deploy-last execution is disabled."
        : "Exact Stellar Testnet bond-vault and route-auction contract IDs are required.",
      contracts: emptyContracts(),
      bindings: null,
    });
  }

  const observations = await Promise.all(
    (Object.keys(STELLAR_SOLVER_MARKET_RELEASES) as ReleaseKey[]).map(async (key) => {
      const contractId = configuredContract(key);
      const release = STELLAR_SOLVER_MARKET_RELEASES[key];
      try {
        const observed = await observeLiveExecutable(contractId);
        const ready = Boolean(
          observed.networkPassphrase === STELLAR_TESTNET.networkPassphrase &&
            observed.observedExecutable === "wasm" &&
            observed.observedWasmSha256 === release.wasmSha256,
        );
        return {
          key,
          contractId,
          expectedWasmSha256: release.wasmSha256,
          observedWasmSha256: observed.observedWasmSha256,
          observedAtLedger: String(observed.latestLedger),
          ready,
        };
      } catch {
        return {
          key,
          contractId,
          expectedWasmSha256: release.wasmSha256,
          observedWasmSha256: null,
          observedAtLedger: null,
          ready: false,
        };
      }
    }),
  );

  let bindings: {
    readonly ready: boolean;
    readonly bondAsset: string;
    readonly minimumBondAtomic: string;
    readonly resolutionGraceLedgers: number;
    readonly coordinator: string;
    readonly settlementAuthority: string;
    readonly treasury: string;
    readonly maximumBids: number;
    readonly observedAtLedger: string;
  } | null = null;
  try {
    const [vault, auction] = await Promise.all([
      simulateGetter(vaultId, "config"),
      simulateGetter(auctionId, "config"),
    ]);
    const bondAsset = String(vault.value.bond_asset ?? "");
    const coordinator = String(vault.value.coordinator ?? "");
    const treasury = String(vault.value.treasury ?? "");
    const minimumBond = BigInt(String(vault.value.minimum_bond ?? "0"));
    const resolutionGraceLedgers = Number(vault.value.resolution_grace_ledgers);
    const settlementAuthority = String(auction.value.settlement_authority ?? "");
    const maximumBids = Number(auction.value.max_bids);
    const bindingReady =
      String(auction.value.bond_vault ?? "") === vaultId &&
      coordinator === settlementAuthority &&
      validAddress(bondAsset) &&
      validAddress(coordinator) &&
      validAddress(treasury) &&
      minimumBond > 0n &&
      Number.isSafeInteger(resolutionGraceLedgers) &&
      resolutionGraceLedgers > 0 &&
      resolutionGraceLedgers <= 120_960 &&
      Number.isSafeInteger(maximumBids) &&
      maximumBids > 0 &&
      maximumBids <= 32;
    bindings = {
      ready: bindingReady,
      bondAsset,
      minimumBondAtomic: minimumBond.toString(),
      resolutionGraceLedgers,
      coordinator,
      settlementAuthority,
      treasury,
      maximumBids,
      observedAtLedger: String(Math.min(vault.latestLedger, auction.latestLedger)),
    };
  } catch {
    bindings = null;
  }
  const ready = observations.every((entry) => entry.ready) && bindings?.ready === true;
  return Object.freeze({
    ...base,
    ready,
    status: ready ? "ready" as const : "live_artifact_or_binding_mismatch" as const,
    reason: ready
      ? "Both Testnet WASM artifacts and the immutable vault/auction constructor bindings match the reviewed release. This is not an audit."
      : "A live WASM artifact or immutable vault/auction constructor binding did not match the reviewed release.",
    contracts: observations,
    bindings,
  });
}
