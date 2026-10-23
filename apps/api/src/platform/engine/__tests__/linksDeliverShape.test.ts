/**
 * Intent links' deliver sizing on the engine's exact delivery (design C.6,
 * red-team E3): runs 2 and 3 reuse the first run's route (venue and shape)
 * and only re-quote amounts, so a "receive at least" link costs one full
 * auction plus at most two single-venue quotes.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { findAssetBySymbol, validateLinkDefinition, type AccountId, type LinkDefinition, type StoredLinkDefinition } from "@kletia/core";
import { planLinkIntent, resetDeliverSizing, sizeDelivery } from "../links/index.js";
import { configurePolicyPricing } from "../policy/pricing.js";
import { configurePreviewPricer } from "../preview/index.js";
import { currentRoutePin } from "../routing/deliverExact.js";
import { EVM_ADDRESS, OTHER_EVM_ADDRESS } from "./helpers.js";
import { installMarket, removeRuleBook, standardPrices } from "./policyHarness.js";
import { installRpcMock, type RpcMock } from "./rpcMock.js";
import { bridgeCalls, resetVenueEngine, venueScripts } from "./venueStubs.js";

const LINK_ID = "lk_5f1c2a9b7e3d4c6a8b0e1f24";
const OWNER = "key_000000000000000000000001";
const MERCHANT = `eip155:8453:${OTHER_EVM_ADDRESS}` as AccountId;
const NOW = Date.parse("2026-10-09T12:00:00Z");

function definition(body: Record<string, unknown>): LinkDefinition {
  const result = validateLinkDefinition({ expiresAt: "2026-12-31T23:59:59Z", blink: false, ...body }, { now: NOW });
  assert.ok(result.ok, JSON.stringify(result.ok ? null : result.issues));
  return result.value;
}

function payLink(): StoredLinkDefinition {
  const usdc = findAssetBySymbol("base", "USDC");
  assert.ok(usdc);
  return {
    definition: definition({
      title: "Pay 25 USDC to Acme",
      publisher: { name: "Acme Store", website: "https://shop.acme.example" },
      destination: { actions: [{ kind: "transfer", network: "base", from: "USDC", amount: "25", recipient: MERCHANT }] },
      funding: { networks: ["base", "arbitrum"], assets: ["USDC"], amount: { mode: "deliver" } },
    }),
    pins: { recipients: [{ action: 0, account: MERCHANT }], contracts: [], destinationAsset: { asset: usdc.id, symbol: usdc.symbol, decimals: usdc.decimals } },
  };
}

describe("deliver sizing pins the first run's route", () => {
  let mock: RpcMock;

  beforeEach(() => {
    resetVenueEngine({ bridges: true });
    resetDeliverSizing();
    mock = installRpcMock();
    standardPrices(installMarket());
    configurePreviewPricer({ price: async (asset) => (/USDC|erc20:0x833589|erc20:0xaf88/u.test(asset) ? 1 : null) });
  });

  afterEach(() => {
    mock.restore();
    configurePolicyPricing(null);
    configurePreviewPricer(null);
    removeRuleBook();
  });

  it("auctions every venue in run 1 and asks only that run's winner in run 2", async () => {
    // Relay wins run 1 but guarantees less than 25 USDC for the first guess: run 2 rescales on Relay alone.
    venueScripts.relay = { minimumBps: 9_900, seconds: 10 };
    venueScripts.lifi = { minimumBps: 9_800, seconds: 10 };
    venueScripts["debridge-dln"] = { minimumBps: 9_800, seconds: 10 };
    const { intent } = await planLinkIntent({
      link: payLink(), linkId: LINK_ID, ownerKeyId: OWNER, choice: { network: "arbitrum", asset: "USDC" }, accounts: [`eip155:42161:${EVM_ADDRESS}` as AccountId], dryRun: true, publisherVerified: true,
    });
    const bridge = intent.steps[0];
    assert.equal(bridge?.protocol, "relay");
    assert.ok(BigInt(bridge?.minimumOutput?.amount ?? "0") >= 25_000_000n);
    const venues = bridgeCalls.map((action) => action.amount);
    assert.equal(bridgeCalls.length, 4, `run 1: three venues; run 2: Relay only (${venues.join(", ")})`);
  });

  it("runs every sizing run inside its own route pin, outside of which there is none", async () => {
    const modes: string[] = [];
    await sizeDelivery({
      key: "pin",
      targetUnits: 25_000_000n,
      targetDecimals: 6,
      inputDecimals: 6,
      plan: async (input, check) => {
        modes.push(currentRoutePin()?.mode ?? "none");
        check(modes.length === 1 ? 24_000_000n : 25_010_000n);
        return input;
      },
    });
    assert.deepEqual(modes, ["record", "replay"]);
    assert.equal(currentRoutePin(), null);
  });
});
