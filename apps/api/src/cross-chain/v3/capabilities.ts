import type { ProtocolCapabilityV3 } from "./types.js";
import { STELLAR_MVP_ENABLED, STELLAR_TESTNET } from "../../networks/stellar/config.js";
import { ARBITRUM_MVP_ENABLED } from "../../shared/config/networks.js";

export interface RuntimeCapabilityEvidenceV3 {
  readonly stellarMpp?: {
    readonly enabled: boolean;
    readonly valid: boolean;
    readonly ready: boolean;
    readonly recipient: string | null;
    readonly databaseConfigured: boolean;
    readonly storeReady: boolean;
  };
}

const unavailable = (
  capability: Omit<ProtocolCapabilityV3, "readiness" | "executionEnabled" | "mockDataAllowed">,
  reason: string,
): ProtocolCapabilityV3 => ({
  ...capability,
  readiness: ["unavailable"],
  executionEnabled: false,
  reason,
  mockDataAllowed: false,
});

export function protocolCapabilitiesV3(
  runtime: RuntimeCapabilityEvidenceV3 = {},
): readonly ProtocolCapabilityV3[] {
  const stellarMpp = runtime.stellarMpp;
  const stellarBase: readonly ProtocolCapabilityV3[] = [
    {
      id: "stellar-classic",
      label: "Stellar Classic payments and SDEX",
      chains: ["stellar_testnet"],
      operations: ["portfolio", "trustline", "transfer", "path_payment", "swap"],
      readiness: STELLAR_MVP_ENABLED ? ["read", "quote", "execute", "verify"] : ["unavailable"],
      executionEnabled: STELLAR_MVP_ENABLED,
      executionChains: STELLAR_MVP_ENABLED ? ["stellar_testnet"] : [],
      reason: STELLAR_MVP_ENABLED ? undefined : "The Stellar Testnet capability flag is disabled.",
      officialSources: [
        "https://developers.stellar.org/docs/build/guides/transactions/path-payments",
        "https://developers.stellar.org/docs/data/apis/horizon/api-reference/resources/paths",
      ],
      deploymentBinding: {
        mode: "runtime_attested",
        identifiers: [STELLAR_TESTNET.networkPassphrase, STELLAR_TESTNET.usdc.issuer, STELLAR_TESTNET.usdc.sac],
      },
      mockDataAllowed: false,
    },
    {
      id: "aquarius",
      label: "Aquarius Soroban AMM",
      chains: ["stellar_testnet"],
      operations: ["swap", "liquidity_add", "liquidity_remove"],
      readiness: STELLAR_MVP_ENABLED ? ["read", "quote"] : ["unavailable"],
      executionEnabled: false,
      reason: STELLAR_MVP_ENABLED
        ? "Read-only quote comparison is available. Execution stays closed until the router WASM and exact-call adapter are reviewed and pinned."
        : "The Stellar Testnet capability flag is disabled.",
      officialSources: [
        "https://docs.aqua.network/developers/code-examples/prerequisites-and-basics",
      ],
      deploymentBinding: {
        mode: "runtime_attested",
        identifiers: [STELLAR_TESTNET.aquarius.router],
      },
      mockDataAllowed: false,
    },
    unavailable(
      {
        id: "soroswap",
        label: "Soroswap aggregated liquidity",
        chains: ["stellar_testnet"],
        operations: ["swap"],
        officialSources: [
          "https://docs.soroswap.finance/additional-resources/01-concepts/aggregator",
        ],
        deploymentBinding: { mode: "discovery_only", identifiers: [] },
      },
      "SOROSWAP_API_KEY and a reviewed Testnet aggregator/router deployment are required before quote or execution is exposed.",
    ),
    unavailable(
      {
        id: "blend-v2",
        label: "Blend V2 lending",
        chains: ["stellar_testnet"],
        operations: ["portfolio", "supply", "withdraw", "borrow_capacity", "repay"],
        officialSources: [
          "https://docs.blend.capital/mainnet-deployments",
          "https://github.com/blend-capital/blend-utils",
        ],
        deploymentBinding: { mode: "discovery_only", identifiers: [] },
      },
      "No reviewed Testnet pool using Circle USDC and non-mock oracle inputs is pinned. Mock fixtures are rejected.",
    ),
    unavailable(
      {
        id: "defindex",
        label: "DeFindex vaults",
        chains: ["stellar_testnet"],
        operations: ["portfolio", "vault_deposit", "vault_withdraw"],
        officialSources: [
          "https://docs.defindex.io/advanced-documentation/sdks/02-defindex-sdk",
        ],
        deploymentBinding: { mode: "discovery_only", identifiers: [] },
      },
      "DEFINDEX_API_KEY and a reviewed Testnet vault/strategy manifest are required.",
    ),
    stellarMpp?.ready
      ? {
          id: "stellar-mpp",
          label: "Stellar Machine Payments Protocol charge",
          chains: ["stellar_testnet"],
          operations: ["data_purchase"],
          readiness: ["read", "execute", "verify"],
          executionEnabled: true,
          executionChains: ["stellar_testnet"],
          reason:
            "Official Stellar MPP charge is enabled with a durable PostgreSQL replay store. Session/channel mode remains disabled until its contract is independently pinned.",
          officialSources: [
            "https://developers.stellar.org/docs/build/agentic-payments/mpp",
          ],
          deploymentBinding: {
            mode: "runtime_attested",
            identifiers: [
              "network:stellar:testnet",
              `currency:${STELLAR_TESTNET.usdc.sac}`,
              `recipient:${stellarMpp.recipient}`,
              "store:postgresql-atomic",
            ],
          },
          mockDataAllowed: false,
        }
      : unavailable(
          {
            id: "stellar-mpp",
            label: "Stellar Machine Payments Protocol charge",
            chains: ["stellar_testnet"],
            operations: ["data_purchase"],
            officialSources: [
              "https://developers.stellar.org/docs/build/agentic-payments/mpp",
            ],
            deploymentBinding: { mode: "discovery_only", identifiers: [] },
          },
          stellarMpp?.valid
            ? "Official MPP charge configuration is valid, but the durable PostgreSQL replay store is not ready. No payment challenge is advertised."
            : stellarMpp?.enabled
              ? "Official MPP charge was enabled with incomplete recipient, secret or PostgreSQL configuration. No payment challenge is advertised."
            : "Official MPP charge is disabled or incomplete. Session/channel mode remains disabled until its contract is pinned; no payment or settlement is fabricated.",
        ),
    unavailable(
      {
        id: "stellar-anchor",
        label: "Stellar anchor rails",
        chains: ["stellar_testnet"],
        operations: ["transfer"],
        officialSources: [
          "https://developers.stellar.org/docs/learn/fundamentals/stellar-ecosystem-proposals",
        ],
        deploymentBinding: { mode: "discovery_only", identifiers: [] },
      },
      "A specific anchor must pass stellar.toml, SEP-10, KYC, quote, status and refund validation before use.",
    ),
  ];

  return Object.freeze([
    {
      id: "base-reviewed-defi",
      label: "Base reviewed DeFi registry",
      chains: ["base_mainnet"],
      operations: [
        "portfolio",
        "swap",
        "supply",
        "withdraw",
        "repay",
        "vault_deposit",
        "vault_withdraw",
        "liquidity_add",
        "liquidity_remove",
        "data_purchase",
      ],
      readiness: ["read", "quote", "execute", "verify"],
      executionEnabled: true,
      executionChains: ["base_mainnet"],
      officialSources: [
        "https://docs.aerodrome.finance/",
        "https://docs.morpho.org/developers/contracts/addresses/",
        "https://docs.moonwell.fi/moonwell/protocol-information/contracts",
      ],
      deploymentBinding: {
        mode: "runtime_attested",
        identifiers: ["existing-base-protocol-registry"],
      },
      mockDataAllowed: false,
    },
    {
      id: "arbitrum-uniswap-aave",
      label: "Arbitrum Uniswap V3 and Aave V3",
      chains: ["arbitrum_one"],
      operations: ["portfolio", "swap", "supply", "withdraw", "borrow_capacity", "repay"],
      readiness: ARBITRUM_MVP_ENABLED ? ["read", "quote", "execute", "verify"] : ["unavailable"],
      executionEnabled: ARBITRUM_MVP_ENABLED,
      executionChains: ARBITRUM_MVP_ENABLED ? ["arbitrum_one"] : [],
      reason: ARBITRUM_MVP_ENABLED ? undefined : "Arbitrum Public Beta is disabled.",
      officialSources: [
        "https://developers.uniswap.org/docs/protocols/v3/deployments/v3-arbitrum-deployments",
        "https://github.com/aave-dao/aave-address-book/blob/main/src/AaveV3Arbitrum.sol",
      ],
      deploymentBinding: {
        mode: "pinned",
        identifiers: ["uniswap-v3-arbitrum", "aave-v3-arbitrum"],
      },
      mockDataAllowed: false,
    },
    unavailable(
      {
        id: "arbitrum-camelot",
        label: "Camelot liquidity",
        chains: ["arbitrum_one"],
        operations: ["swap", "liquidity_add", "liquidity_remove"],
        officialSources: ["https://docs.camelot.exchange/contracts/arbitrum/one-mainnet/"],
        deploymentBinding: {
          mode: "pinned",
          identifiers: [
            "quoter-v3:0x0Fc73040b26E9bC8514fA028D998E73A254Fa76E",
            "router-v3:0x1F721E2E82F6676FCE4eA07A5958cF098D339e18",
          ],
        },
      },
      "Official V3 identities are pinned, but the exact quote/calldata ABI and simulation adapter is incomplete. Explicit Camelot requests fail closed instead of falling back to Uniswap.",
    ),
    {
      id: "arbitrum-compound-v3",
      label: "Compound III on Arbitrum",
      chains: ["arbitrum_one"],
      operations: ["portfolio", "supply", "withdraw", "repay"],
      readiness: ARBITRUM_MVP_ENABLED
        ? ["read", "quote", "execute", "verify"]
        : ["unavailable"],
      executionEnabled: ARBITRUM_MVP_ENABLED,
      executionChains: ARBITRUM_MVP_ENABLED ? ["arbitrum_one"] : [],
      reason: ARBITRUM_MVP_ENABLED
        ? "Native-USDC supply, withdraw and repay are live-bound. Borrow remains disabled until collateral risk is fully modeled."
        : "Arbitrum Public Beta is disabled.",
      officialSources: ["https://github.com/compound-finance/comet/tree/main/deployments/arbitrum"],
      deploymentBinding: {
        mode: "runtime_attested",
        identifiers: [
          "comet-usdc:0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf",
          "base-token:0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
        ],
      },
      mockDataAllowed: false,
    },
    {
      id: "circle-cctp-v2",
      label: "Circle CCTP V2",
      chains: ["base_mainnet", "arbitrum_one", "arc_testnet", "stellar_testnet", "arbitrum_sepolia"],
      operations: ["bridge"],
      readiness: ["quote", "execute", "verify"],
      executionEnabled: true,
      executionChains: ["arc_testnet", "stellar_testnet", "arbitrum_sepolia"],
      reason: "The reviewed execution engine currently covers the Arc–Stellar–Arbitrum Sepolia Testnet corridor. Production Base–Arbitrum CCTP remains route discovery only until its exact adapter is bound.",
      officialSources: [
        "https://developers.circle.com/cctp/references/contract-addresses",
        "https://developers.circle.com/cctp/concepts/supported-chains-and-domains",
      ],
      deploymentBinding: {
        mode: "runtime_attested",
        identifiers: ["domains:3,6,26,27"],
      },
      mockDataAllowed: false,
    },
    {
      id: "across",
      label: "Across bridge and destination actions",
      chains: ["base_mainnet", "arbitrum_one"],
      operations: ["bridge"],
      readiness: ["quote", "execute", "verify"],
      executionEnabled: true,
      executionChains: ["base_mainnet", "arbitrum_one"],
      officialSources: ["https://docs.across.to/introduction/embedded-actions"],
      deploymentBinding: {
        mode: "runtime_attested",
        identifiers: ["existing-across-adapter"],
      },
      mockDataAllowed: false,
    },
    ...stellarBase,
  ] satisfies readonly ProtocolCapabilityV3[]);
}

export function capabilityById(id: string): ProtocolCapabilityV3 | undefined {
  return protocolCapabilitiesV3().find((capability) => capability.id === id);
}
