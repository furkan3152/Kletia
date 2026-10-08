/**
 * Process environment bootstrap. Import this module before any other API
 * module: it loads `.env` and then applies Kletia's public deployment
 * defaults so a fresh checkout runs every production feature that needs no
 * secret.
 *
 * The defaults are public, identity-pinned deployments (addresses, code
 * hashes and the block they were observed at). Every request still
 * re-validates them against the live chain and fails closed on a mismatch.
 * Operator values always win, and a group is only defaulted when its mode
 * key is unset. Set KLETIA_DISABLE_PUBLIC_DEFAULTS=true to opt out.
 */
import * as dotenv from "dotenv";

dotenv.config();

interface DefaultGroup {
  readonly modeKey: string;
  readonly values: Readonly<Record<string, string>>;
}

const PUBLIC_DEPLOYMENT_DEFAULTS: readonly DefaultGroup[] = [
  {
    // Base Intent Router V2 (direct Safe deployment on Base mainnet).
    modeKey: "BASE_SWAP_EXECUTION_MODE",
    values: {
      BASE_SWAP_EXECUTION_MODE: "intent_v2",
      KLETIA_INTENT_ROUTER_V2_ADDRESS: "0xf9BaA05c71c2078A43f6831Eca88220b42932413",
      KLETIA_INTENT_ROUTER_V2_EVIDENCE_JSON:
        "{\"schemaVersion\":\"kletia_base_intent_v2_deployment_v1\",\"validationStatus\":\"validated\",\"chainId\":8453,\"observedAtBlock\":\"49936501\",\"router\":\"0xf9BaA05c71c2078A43f6831Eca88220b42932413\",\"routerCodehash\":\"0x9341d0e8f68d7de4273a47b6f495f4b99335fa9d851bafa3204a91dc3ae2fb52\",\"wrappedNative\":\"0x4200000000000000000000000000000000000006\",\"wrappedNativeCodehash\":\"0x8a3a1f6a9f9dce633117adee5b458245835a8645a8c8726a26382a4622508b1c\",\"feeBps\":10,\"adapters\":[{\"kind\":\"uniswap_v2_compatible\",\"reviewStatus\":\"reviewed\",\"protocolId\":\"uniswap\",\"enabled\":true,\"adapter\":\"0xb21C455ceE9ECb4BD0cf19A88d771065db45592b\",\"target\":\"0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24\",\"spender\":\"0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24\",\"factory\":\"0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6\",\"adapterCodehash\":\"0x0fb7c899f3f97856ee6a83f8e7eb5ede10c341f52e64e92658b35471d3a1dbd7\",\"targetCodehash\":\"0xec2a9bc649a4a1f23eee18c570628b28c03c665cdd7ebbdb3c46a6c4007959c1\",\"spenderCodehash\":\"0xec2a9bc649a4a1f23eee18c570628b28c03c665cdd7ebbdb3c46a6c4007959c1\",\"factoryCodehash\":\"0xbab145d02e7005f0d84c6c1639d39b799b0ea16df99ebbdaf5a14d9da820b4e0\",\"adapterConfigurationHash\":\"0xfbaf94530df666febfb537d12153342f741a4786b39a99cafd708e12a4de6d36\",\"adapterConfigHash\":\"0x56c6c7092dc5af58ddc28ad856ae4cd369b41960ff6d5f5d3a73fa34a6f3c6ad\"}]}",
    },
  },
  {
    // Base LaunchFactory V2 (token launches).
    modeKey: "BASE_TOKEN_DEPLOYMENT_MODE",
    values: {
      BASE_TOKEN_DEPLOYMENT_MODE: "launch_v2",
      KLETIA_LAUNCH_FACTORY_V2_ADDRESS: "0x1D62Ac5e19af7688EbC57f262bbB9959dd78e043",
      KLETIA_LAUNCH_FACTORY_V2_EVIDENCE_JSON:
        "{\"schemaVersion\":\"kletia_launch_factory_v2_direct_safe_deployment_v2\",\"validationStatus\":\"validated\",\"chainId\":8453,\"observedAtBlock\":\"49936548\",\"factory\":\"0x1D62Ac5e19af7688EbC57f262bbB9959dd78e043\",\"factoryCodehash\":\"0xa28d7ef44ecff154d4b24a2f362868bf29e8a9ca7f172d8b0e3cad2b5fc80e81\",\"ownerAuthority\":\"0x84f19Fdfd8C50C6349BFe86Cd90BE131387ab47D\",\"ownerAuthorityCodehash\":\"0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c\",\"ownerAuthorityKind\":\"safe_2_of_2\",\"treasurySafe\":\"0x64261D1AC0133FB1BB2153e1dCa7B081cd9d05fC\",\"treasurySafeCodehash\":\"0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c\",\"pendingTreasury\":\"0x0000000000000000000000000000000000000000\",\"factoryFeeCap\":\"10000000000000000\",\"maxTokenSupply\":\"1000000000000000000000000000000000000\",\"maxNameBytes\":\"64\",\"maxSymbolBytes\":\"16\"}",
    },
  },
  {
    // Arc Testnet Vault V2.
    modeKey: "ARC_VAULT_EXECUTION_MODE",
    values: {
      ARC_VAULT_EXECUTION_MODE: "vault_v2",
      ARC_VAULT_V2_ADDRESS: "0xBe385e3520C20D44697CC1bEEDc9DF759C3A184d",
      ARC_VAULT_V2_RUNTIME_CODEHASH:
        "0xa6cb476a1243a6d9bc71909a5774d1340061e91bcb47cd8aea3df1f5444bec1f",
    },
  },
  {
    modeKey: "ARBITRUM_SEPOLIA_MVP_ENABLED",
    values: { ARBITRUM_SEPOLIA_MVP_ENABLED: "true" },
  },
];

function isUnset(key: string): boolean {
  const value = process.env[key];
  return value === undefined || value.trim() === "";
}

/** Keys filled from public defaults during this process start. */
export const APPLIED_PUBLIC_DEFAULTS: readonly string[] = (() => {
  if (process.env.KLETIA_DISABLE_PUBLIC_DEFAULTS?.trim() === "true") return [];
  const applied: string[] = [];
  for (const group of PUBLIC_DEPLOYMENT_DEFAULTS) {
    if (!isUnset(group.modeKey)) continue;
    for (const [key, value] of Object.entries(group.values)) {
      if (!isUnset(key)) continue;
      process.env[key] = value;
      applied.push(key);
    }
  }
  return Object.freeze(applied);
})();
