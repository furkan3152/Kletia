/**
 * GET /env: which environment variables are set. Booleans only; values are
 * never read into the response.
 */
import type { AdminEnvItem, AdminEnvView } from "@kletia/core";

type Group = readonly [group: string, required: boolean, names: readonly string[]];

const GROUPS: readonly Group[] = [
  ["Core", true, ["NODE_ENV", "KLETIA_DATABASE_URL", "KLETIA_PLATFORM_SECRET", "WORKFLOW_SIGNING_SECRET", "KLETIA_WEB_ORIGIN", "CORS_ORIGINS"]],
  ["Admin", false, ["KLETIA_ADMIN_ADDRESSES", "KLETIA_ADMIN_SOLANA_ADDRESSES", "KLETIA_ADMIN_ORIGINS", "RENDER_API_KEY", "KLETIA_RENDER_API_SERVICE_ID", "KLETIA_RENDER_SITE_SERVICE_ID"]],
  ["Receipts", false, ["KLETIA_RECEIPT_SIGNING_KEY", "KLETIA_RECEIPT_KEY_NOT_BEFORE", "KLETIA_RECEIPT_KEYSET", "KLETIA_EAS_ATTESTER_KEY"]],
  ["RPC", false, ["BASE_RPC_URL", "ARBITRUM_RPC_URL", "ETHEREUM_RPC_URL", "OPTIMISM_RPC_URL", "POLYGON_RPC_URL", "ARC_RPC_URL", "ARBITRUM_SEPOLIA_RPC_URL", "SOLANA_RPC_URL", "SOLANA_DEVNET_RPC_URL"]],
  ["Venues", false, ["RELAY_API_KEY", "LIFI_API_KEY", "DEBRIDGE_ACCESS_TOKEN", "JUPITER_API_KEY", "ACROSS_API_KEY", "ACROSS_INTEGRATOR_ID"]],
  ["Integrations", false, ["OPENROUTER_API_KEY", "KLETIA_ASSISTANT", "KLETIA_ASSISTANT_MODELS", "KLETIA_ASSISTANT_PROFILES", "WEBACY_API_KEY", "ALLORA_API_KEY", "ALCHEMY_API_KEY", "CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "X402_TREASURY_ADDRESS", "KLETIA_OPERATOR_API_KEYS"]],
  ["Deployments", false, ["KLETIA_INTENT_ROUTER_V2_ADDRESS", "KLETIA_INTENT_ROUTER_V2_EVIDENCE_JSON", "KLETIA_LAUNCH_FACTORY_V2_ADDRESS", "KLETIA_LAUNCH_FACTORY_V2_EVIDENCE_JSON", "KLETIA_X402_ATTESTATION_REGISTRY_ADDRESS", "ARC_VAULT_V2_ADDRESS"]],
];

export function envItems(env: NodeJS.ProcessEnv): AdminEnvItem[] {
  const isSet = (name: string) => Boolean(env[name]?.trim());
  const items: AdminEnvItem[] = [];
  for (const [group, required, names] of GROUPS) {
    for (const name of names) items.push({ name, group, required, set: isSet(name) });
  }
  // The admin allowlist is required as a pair: either list alone enables the panel.
  const allowlistSet = isSet("KLETIA_ADMIN_ADDRESSES") || isSet("KLETIA_ADMIN_SOLANA_ADDRESSES");
  return items.map((item) =>
    item.name === "KLETIA_ADMIN_ADDRESSES" || item.name === "KLETIA_ADMIN_SOLANA_ADDRESSES" ? { ...item, required: !allowlistSet || item.set } : item);
}

export function envView(env: NodeJS.ProcessEnv, adminOrigins: readonly string[], store: "postgres" | "memory"): AdminEnvView {
  return { items: envItems(env), adminOrigins: [...adminOrigins], store };
}
