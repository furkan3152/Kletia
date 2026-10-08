import { keccak256 } from "viem";

import { assertArbitrumSepoliaReadiness, ARBITRUM_SEPOLIA, arbitrumSepoliaPublicClient } from "../networks/arbitrum-sepolia/config.js";
import { resolveConfiguredBaseSwapExecution } from "../networks/base/config/intentRouterV2Environment.js";
import { validateBaseIntentV2Runtime } from "../networks/base/intent/routerV2Runtime.js";
import { readSolanaHealth } from "../networks/solana/index.js";
import {
  ARC_CONTRACTS,
  ARC_VAULT_EXECUTION_MODE,
  ARC_VAULT_V2_RUNTIME_CODEHASH,
  NETWORKS,
  arcPublicClient,
  basePublicClient,
} from "../shared/config/networks.js";

export type MvpCheckStatus = "ready" | "unavailable" | "disabled";

export interface MvpReadinessCheck {
  readonly id: string;
  readonly label: string;
  readonly required: boolean;
  readonly status: MvpCheckStatus;
  readonly reason: string;
  readonly evidence: Readonly<Record<string, unknown>> | null;
}

export interface KletiaMvpReadinessReport {
  readonly schemaVersion: "kletia_live_mvp_readiness_v1";
  readonly generatedAt: string;
  readonly profile: "real_data_user_signed_mvp";
  readonly ready: boolean;
  readonly status: "ready_for_user_signed_smoke" | "blocked";
  readonly mockDataAllowed: false;
  readonly checks: readonly MvpReadinessCheck[];
  readonly requiredActions: readonly {
    readonly id: string;
    readonly actor: "user" | "operator";
    readonly reason: string;
    readonly automaticSuccessClaimAllowed: false;
  }[];
  readonly intentionallyUnavailable: readonly {
    readonly capability: string;
    readonly reason: string;
  }[];
}

const LIVE_CHECK_TIMEOUT_MS = 20_000;
const REPORT_CACHE_MS = 30_000;
let cachedReport: { readonly expiresAt: number; readonly report: KletiaMvpReadinessReport } | null = null;
let reportInFlight: Promise<KletiaMvpReadinessReport> | null = null;

function publicErrorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && /^[A-Z0-9_]{3,96}$/u.test(code)
    ? code
    : "LIVE_OBSERVATION_FAILED";
}

async function withTimeout<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(Object.assign(new Error(`${label} timed out.`), { code: "LIVE_CHECK_TIMEOUT" })),
          LIVE_CHECK_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function checked(
  input: {
    readonly id: string;
    readonly label: string;
    readonly required: boolean;
    readonly operation: () => Promise<Readonly<Record<string, unknown>>>;
    readonly readyReason: string;
  },
): Promise<MvpReadinessCheck> {
  try {
    const evidence = await withTimeout(input.operation(), input.label);
    return Object.freeze({
      id: input.id,
      label: input.label,
      required: input.required,
      status: "ready" as const,
      reason: input.readyReason,
      evidence,
    });
  } catch (error) {
    return Object.freeze({
      id: input.id,
      label: input.label,
      required: input.required,
      status: "unavailable" as const,
      reason: `Live check failed (${publicErrorCode(error)}).`,
      evidence: null,
    });
  }
}

async function baseIntentRouterCheck(): Promise<Readonly<Record<string, unknown>>> {
  const config = resolveConfiguredBaseSwapExecution(process.env);
  if (config.mode !== "intent_v2") {
    throw Object.assign(new Error("Base Intent Router V2 is not active."), {
      code: "BASE_INTENT_V2_DISABLED",
    });
  }
  const deployment = await validateBaseIntentV2Runtime(config, basePublicClient);
  return Object.freeze({
    chainId: deployment.chainId,
    observedAtBlock: deployment.observedAtBlock.toString(),
    router: deployment.router,
    routerCodehash: deployment.routerCodehash,
    feeBps: deployment.feeBps,
    enabledAdapters: deployment.adapters.map((adapter) => ({
      protocolId: adapter.protocolId,
      adapter: adapter.adapter,
      target: adapter.target,
    })),
  });
}

async function arcProtocolCheck(): Promise<Readonly<Record<string, unknown>>> {
  const addresses = Object.entries(ARC_CONTRACTS);
  const [chainId, blockNumber, codes] = await Promise.all([
    arcPublicClient.getChainId(),
    arcPublicClient.getBlockNumber(),
    Promise.all(addresses.map(([, address]) => arcPublicClient.getCode({ address }))),
  ]);
  if (chainId !== NETWORKS.arc.chainId || codes.some((code) => !code || code === "0x")) {
    throw Object.assign(new Error("Arc deployment identities are unavailable."), {
      code: "ARC_DEPLOYMENT_ATTESTATION_FAILED",
    });
  }
  if (ARC_VAULT_EXECUTION_MODE !== "vault_v2" || !ARC_VAULT_V2_RUNTIME_CODEHASH) {
    throw Object.assign(new Error("Arc Vault V2 is not configured."), {
      code: "ARC_VAULT_V2_DISABLED",
    });
  }
  const vaultIndex = addresses.findIndex(([name]) => name === "Vault");
  if (
    vaultIndex < 0 ||
    keccak256(codes[vaultIndex]!).toLowerCase() !== ARC_VAULT_V2_RUNTIME_CODEHASH
  ) {
    throw Object.assign(new Error("Arc Vault V2 runtime drifted."), {
      code: "ARC_VAULT_V2_RUNTIME_MISMATCH",
    });
  }
  return Object.freeze({
    chainId,
    blockNumber: blockNumber.toString(),
    contracts: Object.fromEntries(addresses),
    vaultExecutionMode: ARC_VAULT_EXECUTION_MODE,
    vaultRuntimeCodehash: ARC_VAULT_V2_RUNTIME_CODEHASH,
  });
}

async function arbitrumSepoliaCheck(): Promise<Readonly<Record<string, unknown>>> {
  await assertArbitrumSepoliaReadiness();
  const blockNumber = await arbitrumSepoliaPublicClient.getBlockNumber();
  return Object.freeze({
    chainId: ARBITRUM_SEPOLIA.chainId,
    blockNumber: blockNumber.toString(),
    usdc: ARBITRUM_SEPOLIA.usdc,
    aave: ARBITRUM_SEPOLIA.aave,
  });
}

async function solanaRpcCheck(): Promise<Readonly<Record<string, unknown>>> {
  const health = await readSolanaHealth("solana");
  if (!health.ok) {
    throw Object.assign(new Error("Solana Mainnet RPC is unavailable."), {
      code: "SOLANA_RPC_UNAVAILABLE",
    });
  }
  return Object.freeze({
    network: health.network,
    slot: health.slot,
    version: health.version,
    latencyMs: health.latencyMs,
  });
}

async function computeKletiaMvpReadiness(): Promise<KletiaMvpReadinessReport> {
  // Every check targets an independent RPC, so they run in parallel.
  const checks = Object.freeze(await Promise.all([
    checked({
      id: "base_intent_router_v2",
      label: "Base Mainnet Intent Router V2",
      required: true,
      operation: baseIntentRouterCheck,
      readyReason: "The live router, adapter, targets, factories, fee and code hashes match the pinned Base deployment.",
    }),
    checked({
      id: "arc_protocols",
      label: "Arc Testnet Kletia protocols",
      required: true,
      operation: arcProtocolCheck,
      readyReason: "The Arc RPC has the expected chain ID and every MVP contract has live code; Vault V2 matches its pinned runtime hash.",
    }),
    checked({
      id: "arbitrum_sepolia_aave",
      label: "Arbitrum Sepolia Aave/Circle execution endpoint",
      required: true,
      operation: arbitrumSepoliaCheck,
      readyReason: "The live chain, Circle USDC/CCTP and Aave provider bindings match the reviewed Testnet manifest.",
    }),
    checked({
      id: "solana_rpc",
      label: "Solana Mainnet RPC",
      // Informational: a public Solana RPC outage degrades Solana routes but
      // does not block the user-signed EVM MVP smoke.
      required: false,
      operation: solanaRpcCheck,
      readyReason: "The configured Solana Mainnet RPC answered getSlot and getVersion at confirmed commitment.",
    }),
  ]));
  const ready = checks.every((check) => !check.required || check.status === "ready");
  return Object.freeze({
    schemaVersion: "kletia_live_mvp_readiness_v1",
    generatedAt: new Date().toISOString(),
    profile: "real_data_user_signed_mvp",
    ready,
    status: ready ? "ready_for_user_signed_smoke" : "blocked",
    mockDataAllowed: false,
    checks: Object.freeze(checks),
    requiredActions: Object.freeze([
      {
        id: "base_x402_funded_payment",
        actor: "user" as const,
        reason: "A real Base USDC EIP-3009 payment must be signed; success requires both the exact AuthorizationUsed nonce and Transfer evidence.",
        automaticSuccessClaimAllowed: false as const,
      },
      {
        id: "cross_chain_across_workflow",
        actor: "user" as const,
        reason: "A real Base to Arbitrum Across workflow must be signed; success requires a destination fill receipt that delivers the sealed minimum token output.",
        automaticSuccessClaimAllowed: false as const,
      },
    ]),
    intentionallyUnavailable: Object.freeze([
      { capability: "private_evm_or_private_bridge", reason: "No reviewed private Base/Arbitrum bridge or execution rail exists in this MVP." },
    ]),
  });
}

export async function readKletiaMvpReadiness(
  force = false,
): Promise<KletiaMvpReadinessReport> {
  const now = Date.now();
  if (!force && cachedReport && cachedReport.expiresAt > now) {
    return cachedReport.report;
  }
  if (reportInFlight) return reportInFlight;
  reportInFlight = computeKletiaMvpReadiness()
    .then((report) => {
      cachedReport = { expiresAt: Date.now() + REPORT_CACHE_MS, report };
      return report;
    })
    .finally(() => {
      reportInFlight = null;
    });
  return reportInFlight;
}
