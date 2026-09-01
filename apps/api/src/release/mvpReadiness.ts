import { keccak256 } from "viem";

import { readWorkflowCheckpointStoreReadiness } from "../cross-chain/v2/checkpointStore.js";
import { assertArbitrumSepoliaReadiness, ARBITRUM_SEPOLIA, arbitrumSepoliaPublicClient } from "../networks/arbitrum-sepolia/config.js";
import { resolveConfiguredBaseSwapExecution } from "../networks/base/config/intentRouterV2Environment.js";
import { validateBaseIntentV2Runtime } from "../networks/base/intent/routerV2Runtime.js";
import {
  discoverConfiguredPaymentCenterProvider,
  normalizeAnchorOrigin,
  quoteConfiguredStellarPaymentProvider,
  readStellarLastMileReadiness,
} from "../networks/stellar/lastMile.js";
import { readStellarPasskeyAccountReadiness } from "../networks/stellar/passkeyAccounts.js";
import { readPaymentCenterStoreReadiness } from "../networks/stellar/payment-center/store.js";
import { readStellarPaymentCenterProviderManifests } from "../networks/stellar/paymentCenterProviders.js";
import { readStellarReadiness } from "../networks/stellar/service.js";
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

async function stellarExecutionCheck(): Promise<Readonly<Record<string, unknown>>> {
  const readiness = await readStellarReadiness();
  if (readiness.status !== "ready") {
    throw Object.assign(new Error("Stellar Testnet execution is not ready."), {
      code: "STELLAR_EXECUTION_UNAVAILABLE",
    });
  }
  return Object.freeze({
    network: readiness.network,
    latestLedger: readiness.latestLedger,
    rpcLatestLedger: readiness.rpcLatestLedger,
    reviewedContractsAttested: readiness.reviewedContractsAttested,
  });
}

async function stellarPasskeyCheck(): Promise<Readonly<Record<string, unknown>>> {
  const readiness = await readStellarPasskeyAccountReadiness();
  if (!readiness.ready) {
    throw Object.assign(new Error(readiness.reason), {
      code: `STELLAR_PASSKEY_${readiness.status.toUpperCase()}`,
    });
  }
  return Object.freeze({
    network: readiness.network,
    release: readiness.release,
    capability: readiness.capability,
    observations: readiness.observations,
  });
}

function configuredAnchorDomains(): readonly string[] {
  return Object.freeze(
    [...new Set(
      (process.env.STELLAR_ANCHOR_ALLOWLIST || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => new URL(normalizeAnchorOrigin(value)).hostname),
    )],
  );
}

async function paymentCenterCoreCheck(): Promise<Readonly<Record<string, unknown>>> {
  const readiness = readStellarLastMileReadiness();
  if (readiness.paymentCore !== "discovery_configured") {
    throw Object.assign(new Error(readiness.reason), {
      code: "STELLAR_PAYMENT_CENTER_DISCOVERY_UNAVAILABLE",
    });
  }
  const store = await readPaymentCenterStoreReadiness();
  return Object.freeze({
    configuredAnchors: readiness.configuredAnchors,
    identity: readiness.identity,
    settlement: readiness.settlement,
    execution: readiness.execution,
    store,
    mockData: readiness.mockData,
  });
}

async function reviewedPaymentProviderCheck(): Promise<Readonly<Record<string, unknown>>> {
  const configured = new Set(configuredAnchorDomains());
  const providers = readStellarPaymentCenterProviderManifests().filter(
    (provider) => configured.has(provider.domain),
  );
  const settlementProviders = providers.filter(
    (provider) =>
      provider.role === "reviewed_anchor" &&
      !provider.referenceOnly &&
      provider.realWorldSettlement,
  );
  if (settlementProviders.length === 0) {
    throw Object.assign(
      new Error(
        "No configured provider is reviewed for real-world settlement; reference anchors cannot satisfy the payout release gate.",
      ),
      { code: "STELLAR_PAYMENT_PROVIDER_NOT_CONFIGURED" },
    );
  }
  const discoveries = await Promise.all(
    settlementProviders.map(async (provider) => {
      if (!provider.releaseProbe) {
        throw Object.assign(
          new Error(
            `${provider.domain} has no operator-reviewed live release probe.`,
          ),
          { code: "STELLAR_PAYMENT_PROVIDER_PROBE_MISSING" },
        );
      }
      const discovery = await discoverConfiguredPaymentCenterProvider(
        provider.domain,
      );
      if (
        !discovery.transferServerSep24 ||
        !discovery.anchorQuoteServer ||
        !discovery.sep45Advertised ||
        !discovery.webAuthForContractsEndpoint ||
        !discovery.webAuthContractId ||
        !discovery.signingKey
      ) {
        throw Object.assign(
          new Error(
            `${provider.domain} does not currently advertise the reviewed SEP-24, SEP-38 and SEP-45 identity surface.`,
          ),
          { code: "STELLAR_PAYMENT_PROVIDER_CAPABILITY_MISMATCH" },
        );
      }
      const quote = await quoteConfiguredStellarPaymentProvider(
        provider.domain,
        provider.releaseProbe,
      );
      if (
        quote.provider !== provider.domain ||
        quote.realWorldSettlement !== true ||
        !quote.sep24 ||
        !quote.sep38 ||
        !quote.sep45Advertised ||
        quote.mockData
      ) {
        throw Object.assign(
          new Error(
            `${provider.domain} failed the exact live payout release probe.`,
          ),
          { code: "STELLAR_PAYMENT_PROVIDER_PROBE_FAILED" },
        );
      }
      return {
        domain: provider.domain,
        networkPassphrase: discovery.networkPassphrase,
        sep24: true,
        sep38: true,
        sep45: true,
        probe: {
          destinationCountry: quote.destinationCountry,
          destinationCurrency: quote.destinationCurrency,
          deliveryMethod: quote.deliveryMethod,
          quoteType: quote.quoteType,
          observedAt: quote.observedAt,
          mockData: quote.mockData,
        },
      };
    }),
  );
  return Object.freeze({
    providers: settlementProviders.map((provider) => ({
      domain: provider.domain,
      reviewedAt: provider.reviewedAt,
      expectedCapabilities: provider.expectedCapabilities,
      realWorldSettlement: provider.realWorldSettlement,
    })),
    discoveries,
    referenceAnchorsExcluded: providers
      .filter((provider) => provider.referenceOnly)
      .map((provider) => provider.domain),
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

async function workflowStoresCheck(): Promise<Readonly<Record<string, unknown>>> {
  const v2 = await readWorkflowCheckpointStoreReadiness();
  if (v2.status !== "ready") {
    throw Object.assign(new Error("The reviewed multichain workflow store is unavailable."), {
      code: "WORKFLOW_STORE_UNAVAILABLE",
    });
  }
  return Object.freeze({ reviewedWorkflow: "v2", v2 });
}

async function computeKletiaMvpReadiness(): Promise<KletiaMvpReadinessReport> {
  // Public Stellar Testnet RPC is deliberately not fanned out here. Each
  // Stellar readiness probe already performs parallel contract observations;
  // running all of those probes at once can trigger provider throttling and
  // turn a healthy release into a false negative. Independent EVM/store checks
  // remain parallel, while the Stellar groups execute in a bounded sequence.
  const [base, arc, arbitrumSepolia, stores] = await Promise.all([
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
      id: "durable_workflow_stores",
      label: "Reviewed multichain workflow durable state",
      required: true,
      operation: workflowStoresCheck,
      readyReason: "The reviewed V2 checkpoint store is durable and responds to a real database read.",
    }),
  ]);
  const stellarExecution = await checked({
      id: "stellar_execution",
      label: "Stellar Testnet native execution",
      required: true,
      operation: stellarExecutionCheck,
      readyReason: "Horizon, Soroban RPC and reviewed Stellar execution contracts are live-attested.",
    });
  const stellarPasskey = await checked({
    id: "stellar_passkey_payment_identity",
    label: "Stellar secp256r1 passkey payment identity",
    required: true,
    operation: stellarPasskeyCheck,
    readyReason: "The account WASM, WebAuthn verifier, Circle USDC SAC and fee-sponsoring Testnet relayer match the pinned passkey profile.",
  });
  const paymentCenter = await checked({
    id: "stellar_payment_center_core",
    label: "Stellar Payment Center session and provider boundary",
    required: true,
    operation: paymentCenterCoreCheck,
    readyReason: "Allowlisted anchor discovery and durable Payment Center session storage are configured without mock data.",
  });
  const paymentProvider = await checked({
    id: "stellar_reviewed_payment_provider",
    label: "Reviewed Stellar payout provider",
    required: true,
    operation: reviewedPaymentProviderCheck,
    readyReason: "At least one configured non-reference provider is reviewed and currently advertises the required SEP-24, SEP-38 and SEP-45 surface.",
  });
  const checks = Object.freeze([
    base,
    arc,
    stellarExecution,
    stellarPasskey,
    paymentCenter,
    paymentProvider,
    arbitrumSepolia,
    stores,
  ]);
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
        id: "payment_center_user_signed_lifecycle",
        actor: "user" as const,
        reason: "A real passkey SEP-45 authentication, firm quote, SEP-24 withdrawal, exact USDC transfer, delivery and refund/recovery drill must be funded and approved by the user.",
        automaticSuccessClaimAllowed: false as const,
      },
      {
        id: "base_x402_funded_payment",
        actor: "user" as const,
        reason: "A real Base USDC EIP-3009 payment must be signed; success requires both the exact AuthorizationUsed nonce and Transfer evidence.",
        automaticSuccessClaimAllowed: false as const,
      },
      {
        id: "payment_center_provider_integration",
        actor: "operator" as const,
        reason: "A reviewed provider must support the exact Circle USDC, SEP-24, SEP-38 context=sep24 and SEP-45 contract-account combination; the SDF reference anchor does not satisfy this production-facing gate.",
        automaticSuccessClaimAllowed: false as const,
      },
    ]),
    intentionallyUnavailable: Object.freeze([
      { capability: "private_evm_or_private_bridge", reason: "No reviewed private Base/Arbitrum bridge or execution rail exists in this MVP." },
      { capability: "stellar_usdc_private_pool", reason: "The pinned Stellar private-payment release supports XLM/EURC, not USDC." },
      { capability: "soroswap_blend_defindex_execution", reason: "Exact live Testnet deployment identities and reviewed adapters are not available, so these remain fail-closed." },
      { capability: "stellar_solver_policy_private_payment_labs_as_core", reason: "Solver auctions, Policy V2/control-plane and shielded-payment experiments are reproducible labs, not dependencies of the default Stellar Payment Center release." },
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
