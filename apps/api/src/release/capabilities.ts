/**
 * Feature readiness report. One server-side source of truth that the web
 * app, SDK and widget read to decide whether a feature is live, needs
 * operator configuration, or is disabled - instead of guessing from
 * client-side flags.
 */
import { APPLIED_PUBLIC_DEFAULTS } from "../shared/config/environment.js";
import {
  ARBITRUM_MVP_ENABLED,
  ARC_VAULT_EXECUTION_MODE,
} from "../shared/config/networks.js";
import { ARBITRUM_SEPOLIA_MVP_ENABLED } from "../networks/arbitrum-sepolia/config.js";
import { platformSecretStatus } from "../platform/http/secrets.js";

export type FeatureState = "live" | "needs_configuration" | "disabled";

export interface FeatureCapability {
  readonly id: string;
  readonly network: string;
  readonly name: string;
  readonly state: FeatureState;
  readonly detail: string;
  /** Environment variables an operator sets to make the feature live. */
  readonly requires?: readonly string[];
}

const has = (...keys: string[]) => keys.every((key) => Boolean(process.env[key]?.trim()));

function feature(
  id: string,
  network: string,
  name: string,
  live: boolean,
  liveDetail: string,
  requires: readonly string[] = [],
): FeatureCapability {
  return live
    ? { id, network, name, state: "live", detail: liveDetail }
    : {
        id,
        network,
        name,
        state: "needs_configuration",
        detail: `Set ${requires.join(" and ")} on the API to enable this feature.`,
        requires,
      };
}

function webhookCapability(): FeatureCapability {
  const base = { id: "platform.webhooks", network: "all", name: "Signed webhooks (Platform API v1)" } as const;
  switch (platformSecretStatus()) {
    case "configured":
      return { ...base, state: "live", detail: "Webhook secrets sealed with KLETIA_PLATFORM_SECRET." };
    case "development_fallback":
      return { ...base, state: "live", detail: "Development sealing key (in-memory store only); set KLETIA_PLATFORM_SECRET before production." };
    default:
      return {
        ...base,
        state: "needs_configuration",
        detail: "Set KLETIA_PLATFORM_SECRET (at least 32 characters) on the API to enable webhooks.",
        requires: ["KLETIA_PLATFORM_SECRET"],
      };
  }
}

export function readFeatureCapabilities(): {
  readonly features: readonly FeatureCapability[];
  readonly publicDefaults: readonly string[];
} {
  const baseSwapMode = process.env.BASE_SWAP_EXECUTION_MODE?.trim() || "legacy_v1";
  const launchMode = process.env.BASE_TOKEN_DEPLOYMENT_MODE?.trim() || "legacy_v1";
  const webacy = has("WEBACY_API_KEY");
  const features: FeatureCapability[] = [
    {
      id: "base.swap",
      network: "base",
      name: "Swaps via Kletia Intent Router V2",
      state: baseSwapMode === "intent_v2" ? "live" : "disabled",
      detail:
        baseSwapMode === "intent_v2"
          ? "Identity-pinned router re-validated against Base on every quote."
          : "BASE_SWAP_EXECUTION_MODE is not intent_v2.",
    },
    {
      id: "base.token_launch",
      network: "base",
      name: "Token launch (LaunchFactory V2)",
      state: launchMode === "launch_v2" ? "live" : "disabled",
      detail:
        launchMode === "launch_v2"
          ? "Pinned factory evidence validated at deployment block."
          : "BASE_TOKEN_DEPLOYMENT_MODE is not launch_v2.",
    },
    {
      id: "base.presign_screening",
      network: "base",
      name: "Pre-sign target screening",
      state: "live",
      detail: webacy
        ? "Webacy risk scoring plus reviewed target manifest."
        : "Reviewed target manifest plus RPC bytecode attestation (add WEBACY_API_KEY for risk scoring).",
    },
    feature("base.address_risk", "base", "Address risk scanner", webacy, "Webacy threat intelligence.", ["WEBACY_API_KEY"]),
    feature("base.allora", "base", "Allora price inference", has("ALLORA_API_KEY"), "Allora network inference.", ["ALLORA_API_KEY"]),
    feature(
      "base.bridge_across",
      "base",
      "Across bridge and Base→Arbitrum staged workflow",
      has("ACROSS_API_KEY", "ACROSS_INTEGRATOR_ID"),
      "Across intents with destination fill verification.",
      ["ACROSS_API_KEY", "ACROSS_INTEGRATOR_ID"],
    ),
    feature(
      "base.paymaster",
      "base",
      "Sponsored gas (CDP Paymaster)",
      process.env.PAYMASTER_PROXY_ENABLED === "true" && has("CDP_PAYMASTER_POLICY_ID"),
      "Policy-scoped CDP paymaster proxy.",
      ["PAYMASTER_PROXY_ENABLED=true", "CDP_PAYMASTER_POLICY_ID", "CDP_PAYMASTER_URL"],
    ),
    feature(
      "base.onramp",
      "base",
      "Card on-ramp (Coinbase)",
      has("CDP_API_KEY_NAME", "CDP_API_KEY_PRIVATE_KEY"),
      "Coinbase Onramp session tokens.",
      ["CDP_API_KEY_NAME", "CDP_API_KEY_PRIVATE_KEY"],
    ),
    feature(
      "base.x402_premium",
      "base",
      "Paid x402 data endpoints",
      (has("CDP_API_KEY_ID", "CDP_API_KEY_SECRET") ||
        has("CDP_API_KEY_NAME", "CDP_API_KEY_PRIVATE_KEY")) &&
        (process.env.NODE_ENV !== "production" ||
          has("X402_TREASURY_ADDRESS") ||
          has("KLETIA_FEE_RECIPIENT")),
      "CDP x402 facilitator and a payment recipient.",
      ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "X402_TREASURY_ADDRESS"],
    ),
    feature(
      "base.portfolio_discovery",
      "base",
      "Full ERC-20 portfolio discovery",
      has("ALCHEMY_API_KEY"),
      "Alchemy token balance discovery.",
      ["ALCHEMY_API_KEY"],
    ),
    feature(
      "ai.semantic_parsing",
      "all",
      "AI-assisted intent interpretation (opt-in per request)",
      has("OPENROUTER_API_KEY"),
      "Model interpretation behind explicit user consent; execution stays deterministic.",
      ["OPENROUTER_API_KEY"],
    ),
    {
      id: "arc.vault_v2",
      network: "arc",
      name: "Arc Vault V2",
      state: ARC_VAULT_EXECUTION_MODE === "vault_v2" ? "live" : "disabled",
      detail:
        ARC_VAULT_EXECUTION_MODE === "vault_v2"
          ? "Runtime codehash pinned."
          : "Legacy V1 vault in use.",
    },
    {
      id: "arbitrum.network",
      network: "arbitrum",
      name: "Arbitrum One",
      state: ARBITRUM_MVP_ENABLED ? "live" : "disabled",
      detail: ARBITRUM_MVP_ENABLED
        ? has("ARBITRUM_RPC_URL")
          ? "Private RPC configured."
          : "Using the public Arbitrum RPC (set ARBITRUM_RPC_URL in production)."
        : "ARBITRUM_MVP_ENABLED=false.",
    },
    {
      id: "arbitrum-sepolia.network",
      network: "arbitrum-sepolia",
      name: "Arbitrum Sepolia Aave workflow",
      state: ARBITRUM_SEPOLIA_MVP_ENABLED ? "live" : "disabled",
      detail: ARBITRUM_SEPOLIA_MVP_ENABLED ? "Circle Testnet USDC and Aave V3." : "ARBITRUM_SEPOLIA_MVP_ENABLED=false.",
    },
    {
      id: "solana.network",
      network: "solana",
      name: "Solana (Jupiter, transfers, Kamino, Relay)",
      state: "live",
      detail: has("SOLANA_RPC_URL")
        ? "Private RPC configured."
        : "Using the public Solana RPC (set SOLANA_RPC_URL in production).",
    },
    {
      id: "platform.persistence",
      network: "all",
      name: "Durable platform store (intents, keys, webhooks)",
      state: has("KLETIA_DATABASE_URL") ? "live" : "needs_configuration",
      detail: has("KLETIA_DATABASE_URL")
        ? "PostgreSQL."
        : "In-memory store; set KLETIA_DATABASE_URL for durability across restarts.",
      ...(has("KLETIA_DATABASE_URL") ? {} : { requires: ["KLETIA_DATABASE_URL"] }),
    },
    webhookCapability(),
  ];
  return { features, publicDefaults: APPLIED_PUBLIC_DEFAULTS };
}
