import { protocolCapabilitiesV3, type RuntimeCapabilityEvidenceV3 } from "../v3/capabilities.js";
import type { ProtocolCapabilityV3 } from "../v3/types.js";
import type {
  CapabilityEdgeV1,
  CapabilityStageReadinessV4,
  NetworkRoleV4,
} from "./types.js";

const unavailableStages = Object.freeze({
  discover: "unavailable",
  quote: "unavailable",
  hydrate: "unavailable",
  simulate: "unavailable",
  execute: "unavailable",
  verify: "unavailable",
  recover: "unavailable",
} as const);

function localStages(capability: ProtocolCapabilityV3): CapabilityEdgeV1["stages"] {
  if (capability.readiness.includes("unavailable")) return unavailableStages;
  const hasQuote = capability.readiness.includes("quote");
  const hasExecute = capability.executionEnabled && capability.readiness.includes("execute");
  const hasVerify = capability.readiness.includes("verify");
  return Object.freeze({
    discover: capability.readiness.includes("read") || hasQuote ? "ready" : "unavailable",
    quote: hasQuote ? "ready" : "unavailable",
    hydrate: hasExecute ? "legacy_only" : "adapter_required",
    simulate: hasExecute ? "legacy_only" : "adapter_required",
    execute: hasExecute ? "legacy_only" : "unavailable",
    verify: hasVerify ? "legacy_only" : "unavailable",
    recover: hasExecute ? "legacy_only" : "unavailable",
  });
}

function localEdges(runtime: RuntimeCapabilityEvidenceV3): CapabilityEdgeV1[] {
  return protocolCapabilitiesV3(runtime).flatMap((capability) => capability.chains
    .filter((chain) => capability.id !== "circle-cctp-v2" && capability.id !== "across")
    .map((chain): CapabilityEdgeV1 => ({
      schemaVersion: "kletia_capability_edge_v1",
      id: `local:${chain}:${capability.id}`,
      lane: chain.endsWith("testnet") || chain.endsWith("sepolia") ? "testnet" : "production",
      source: chain,
      destination: chain,
      protocol: capability.id,
      operations: capability.operations,
      stages: localStages(capability),
      exactBinding: capability.executionEnabled ? "network_local_legacy" : "read_only",
      officialSources: capability.officialSources,
      limitations: [
        capability.reason ?? "The protocol is exposed through its reviewed network-local adapter.",
        "V4 does not call a protocol-level capability signable until exact target, calldata or XDR, quote, simulation and evidence bindings are present.",
      ],
      mockDataAllowed: false,
    })));
}

function bridgeEdge(input: Omit<CapabilityEdgeV1, "schemaVersion" | "mockDataAllowed">): CapabilityEdgeV1 {
  return { ...input, schemaVersion: "kletia_capability_edge_v1", mockDataAllowed: false };
}

const legacyArcStages = Object.freeze({
  discover: "ready",
  quote: "legacy_only",
  hydrate: "legacy_only",
  simulate: "legacy_only",
  execute: "legacy_only",
  verify: "legacy_only",
  recover: "legacy_only",
} satisfies Record<string, CapabilityStageReadinessV4>);

function arcEdges(): readonly CapabilityEdgeV1[] {
  return Object.freeze([
    bridgeEdge({
      id: "local:arc_testnet:kletia-arc-defi",
      lane: "testnet",
      source: "arc_testnet",
      destination: "arc_testnet",
      protocol: "kletia-arc-defi",
      operations: [
        "portfolio",
        "swap",
        "stake",
        "unstake",
        "claim_rewards",
        "claim_unstaked",
        "vault_deposit",
        "vault_withdraw",
        "lending_deposit",
        "lending_withdraw",
        "lending_borrow",
        "lending_repay",
        "liquidity_add",
        "liquidity_remove",
        "memo_send",
      ],
      stages: legacyArcStages,
      exactBinding: "network_local_legacy",
      officialSources: [
        "https://docs.arc.network/arc/concepts/native-gas-token",
      ],
      limitations: [
        "These are Kletia-owned Arc Testnet contracts, not Arc-native DeFi protocols or production deployments.",
        "Arc native-value USDC uses 18 atomic decimals while ERC-20 and Circle App Kit USDC use 6; the two rails must never share amount hydration.",
        "V4 may discover this reviewed legacy engine, but exact V4 signability remains closed until its plan, simulation and receipt adapters are migrated.",
      ],
    }),
    bridgeEdge({
      id: "local:arc_testnet:arc-official-payments",
      lane: "testnet",
      source: "arc_testnet",
      destination: "arc_testnet",
      protocol: "arc-official-payments",
      operations: ["official_memo_send", "atomic_payout"],
      stages: legacyArcStages,
      exactBinding: "network_local_legacy",
      officialSources: [
        "https://docs.arc.network/arc/references/contract-addresses",
      ],
      limitations: [
        "Memo contents and payout recipients are public on Arc Testnet.",
        "The legacy engine checks exact selectors, targets, EOA semantics and live simulation; V4 still requires its own sealed adapter before exposing a signing payload.",
      ],
    }),
    bridgeEdge({
      id: "local:arc_testnet:circle-app-kit",
      lane: "testnet",
      source: "arc_testnet",
      destination: "arc_testnet",
      protocol: "circle-app-kit",
      operations: ["stable_swap", "appkit_send"],
      stages: {
        discover: "ready",
        quote: "legacy_only",
        hydrate: "legacy_only",
        simulate: "legacy_only",
        execute: "legacy_only",
        verify: "legacy_only",
        recover: "legacy_only",
      },
      exactBinding: "network_local_legacy",
      officialSources: [
        "https://docs.arc.network/app-kit/quickstarts/bridge-tokens-across-blockchains",
      ],
      limitations: [
        "Circle App Kit obtains its own live estimate and wallet approval; a Kletia planner response is not a settlement result.",
        "App Kit stablecoin amounts use token decimals and must not be treated as Arc native-value atomic units.",
      ],
    }),
    bridgeEdge({
      id: "local:arc_testnet:kletia-agent-registry",
      lane: "testnet",
      source: "arc_testnet",
      destination: "arc_testnet",
      protocol: "kletia-agent-registry",
      operations: ["agent_discovery"],
      stages: {
        ...unavailableStages,
        discover: "legacy_only",
      },
      exactBinding: "read_only",
      officialSources: [],
      limitations: [
        "This is Kletia's legacy custom registry and is not presented as ERC-8004 or ERC-8183.",
        "Agent registration, reputation writes and delegated execution remain unavailable in V4 until an exact standard and deployment manifest are reviewed.",
      ],
    }),
  ]);
}

export function networkRolesV4(): readonly NetworkRoleV4[] {
  return Object.freeze([
    {
      chain: "stellar_testnet",
      lane: "testnet",
      role: "intent_control_policy_receipt_center",
      readiness: "deployment_required",
      responsibilities: [
        "Anchor the signed workflow root and nullifier before any financial execution.",
        "Verify the version-pinned policy proof and finalize the execution receipt root.",
        "Coordinate Stellar-native payment, path-payment and confidential-treasury capabilities when those exact adapters are ready.",
      ],
      nonClaims: [
        "Stellar does not independently prove a foreign-chain receipt.",
        "A control-plane anchor does not make a cross-chain workflow globally atomic or private.",
      ],
    },
    {
      chain: "stellar_mainnet",
      lane: "production",
      role: "intent_control_policy_receipt_center",
      readiness: "deployment_required",
      responsibilities: [
        "Provide the production policy and receipt anchor after contracts, verifier artifacts and governance are deployed and pinned.",
      ],
      nonClaims: ["Production financial execution remains fail-closed until this control plane is live-attested."],
    },
    {
      chain: "arc_testnet",
      lane: "testnet",
      role: "stablecoin_agent_hub",
      readiness: "live_legacy",
      responsibilities: [
        "Provide the native-USDC test environment, Kletia stablecoin application routes, official memo and atomic payout calls, and the CCTP corridor.",
        "Act as the testnet origin for Arc to Stellar to Arbitrum Sepolia checkpoint workflows.",
      ],
      nonClaims: [
        "Kletia-owned Arc contracts are not represented as official Arc protocols.",
        "No ERC-8004 or ERC-8183 support is claimed without a reviewed standard adapter and deployment manifest.",
      ],
    },
    {
      chain: "base_mainnet",
      lane: "production",
      role: "liquidity_execution_domain",
      readiness: "live_legacy",
      responsibilities: ["Supply production liquidity, DeFi execution and the existing evidence-bound x402 buyer flow."],
      nonClaims: [
        "A V4 Base execution cannot bypass its signed Stellar policy lifecycle; existing legacy Base modes remain separate migration paths.",
      ],
    },
    {
      chain: "arbitrum_one",
      lane: "production",
      role: "liquidity_execution_domain",
      readiness: "capability_gated",
      responsibilities: ["Supply production swap and lending execution when the Arbitrum Public Beta flag and exact adapter are ready."],
      nonClaims: ["A Base-origin Across adapter does not imply a reviewed Arbitrum-origin executor."],
    },
    {
      chain: "arbitrum_sepolia",
      lane: "testnet",
      role: "liquidity_execution_domain",
      readiness: "capability_gated",
      responsibilities: ["Provide the testnet Aave supply and read-only borrow-capacity destination for CCTP workflows."],
      nonClaims: ["The MVP does not execute borrow or represent testnet results as production performance."],
    },
  ] satisfies readonly NetworkRoleV4[]);
}

export function capabilityEdgesV4(
  runtime: RuntimeCapabilityEvidenceV3 = {},
): readonly CapabilityEdgeV1[] {
  const exactTestnetCctp = Object.freeze({
    discover: "ready",
    quote: "ready",
    hydrate: "legacy_only",
    simulate: "legacy_only",
    execute: "legacy_only",
    verify: "legacy_only",
    recover: "legacy_only",
  } satisfies Record<string, CapabilityStageReadinessV4>);
  return Object.freeze([
    ...localEdges(runtime),
    ...arcEdges(),
    bridgeEdge({
      id: "bridge:arc_testnet:arbitrum_sepolia:circle-cctp-v2",
      lane: "testnet",
      source: "arc_testnet",
      destination: "arbitrum_sepolia",
      protocol: "circle-cctp-v2",
      operations: ["bridge"],
      stages: exactTestnetCctp,
      exactBinding: "reviewed_v2",
      officialSources: ["https://developers.circle.com/cctp/concepts/supported-chains-and-domains"],
      limitations: ["Public CCTP amounts, addresses and timing are not confidential.", "The bridge is checkpointed and never represented as globally atomic."],
    }),
    bridgeEdge({
      id: "bridge:arc_testnet:stellar_testnet:circle-cctp-v2",
      lane: "testnet",
      source: "arc_testnet",
      destination: "stellar_testnet",
      protocol: "circle-cctp-v2",
      operations: ["bridge"],
      stages: exactTestnetCctp,
      exactBinding: "reviewed_v2",
      officialSources: ["https://developers.circle.com/cctp/references/stellar-contracts"],
      limitations: ["This public CCTP hop is not a privacy bridge.", "Six-to-seven decimal conversion must remain lossless."],
    }),
    bridgeEdge({
      id: "bridge:stellar_testnet:arbitrum_sepolia:circle-cctp-v2",
      lane: "testnet",
      source: "stellar_testnet",
      destination: "arbitrum_sepolia",
      protocol: "circle-cctp-v2",
      operations: ["bridge"],
      stages: exactTestnetCctp,
      exactBinding: "reviewed_v2",
      officialSources: ["https://developers.circle.com/cctp/references/stellar-contracts"],
      limitations: ["This public CCTP hop is not a privacy bridge.", "The Stellar burn and EVM mint are separate checkpoints."],
    }),
    bridgeEdge({
      id: "bridge:base_mainnet:arbitrum_one:across-swap-api",
      lane: "production",
      source: "base_mainnet",
      destination: "arbitrum_one",
      protocol: "across",
      operations: ["bridge"],
      stages: {
        discover: "ready",
        quote: "legacy_only",
        hydrate: "adapter_required",
        simulate: "adapter_required",
        execute: "legacy_only",
        verify: "legacy_only",
        recover: "legacy_only",
      },
      exactBinding: "network_local_legacy",
      officialSources: ["https://docs.across.to/developer-quickstart/bridge"],
      limitations: ["The current adapter is Base-origin only and still requires migration to the current Swap API approval/status surface before V4 execution."],
    }),
    bridgeEdge({
      id: "bridge:arbitrum_one:base_mainnet:across-swap-api",
      lane: "production",
      source: "arbitrum_one",
      destination: "base_mainnet",
      protocol: "across",
      operations: ["bridge"],
      stages: {
        ...unavailableStages,
        discover: "ready",
        quote: "adapter_required",
      },
      exactBinding: "read_only",
      officialSources: ["https://docs.across.to/chains-and-contracts"],
      limitations: ["The repository does not yet contain a reviewed Arbitrum-origin executor; V4 fails closed instead of inferring bidirectional readiness."],
    }),
  ]);
}
