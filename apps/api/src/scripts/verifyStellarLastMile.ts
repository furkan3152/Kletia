import assert from "node:assert/strict";

import {
  assertAllowedAnchorEndpoint,
  compareStellarLastMileRoutes,
  normalizeAnchorOrigin,
  parseAnchorStellarToml,
  quoteConfiguredStellarPaymentProvider,
  readStellarLastMileReadiness,
  validateStellarLastMileQuoteRequest,
} from "../networks/stellar/lastMile.js";
import { readStellarPaymentCenterProviderManifests } from "../networks/stellar/paymentCenterProviders.js";

const parsed = parseAnchorStellarToml(`
SIGNING_KEY = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"
NETWORK_PASSPHRASE = "Test SDF Network ; September 2015"
TRANSFER_SERVER = "https://anchor.example/sep6"
TRANSFER_SERVER_SEP0024 = "https://anchor.example/sep24"
DIRECT_PAYMENT_SERVER = "https://anchor.example/sep31"
ANCHOR_QUOTE_SERVER = "https://anchor.example/sep38"
WEB_AUTH_FOR_CONTRACTS_ENDPOINT = "https://anchor.example/sep45/auth"
WEB_AUTH_CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4"
[DOCUMENTATION]
DIRECT_PAYMENT_SERVER = "https://attacker.example/sep31"
`);
assert.equal(parsed.DIRECT_PAYMENT_SERVER, "https://anchor.example/sep31");
assert.equal(parsed.TRANSFER_SERVER_SEP0024, "https://anchor.example/sep24");
assert.equal(parsed.ANCHOR_QUOTE_SERVER, "https://anchor.example/sep38");

assert.equal(normalizeAnchorOrigin("anchor.example"), "https://anchor.example");
assert.throws(() => normalizeAnchorOrigin("http://anchor.example"));
assert.throws(() => normalizeAnchorOrigin("https://127.0.0.1"));
assert.throws(() => normalizeAnchorOrigin("https://anchor.example/path"));

const allowed = new Set(["anchor.example"]);
assert.equal(
  assertAllowedAnchorEndpoint("https://anchor.example/sep38", allowed),
  "https://anchor.example/sep38",
);
assert.throws(() =>
  assertAllowedAnchorEndpoint("https://attacker.example/sep38", allowed),
);
assert.throws(() =>
  assertAllowedAnchorEndpoint("https://anchor.example/sep38?token=secret", allowed),
);

const request = validateStellarLastMileQuoteRequest({
  sourceNetwork: "arc_testnet",
  amountMode: "send_exact",
  amount: "25.5",
  destinationCountry: "tr",
  destinationCurrency: "try",
  deliveryMethod: "bank",
});
assert.deepEqual(request, {
  sourceNetwork: "arc_testnet",
  amountMode: "send_exact",
  amount: "25.5",
  destinationCountry: "TR",
  destinationCurrency: "TRY",
  deliveryMethod: "BANK",
});
assert.throws(() =>
  validateStellarLastMileQuoteRequest({
    ...request,
    sourceNetwork: "base_mainnet",
  }),
);
assert.throws(() =>
  validateStellarLastMileQuoteRequest({ ...request, amount: "-1" }),
);
assert.throws(() =>
  validateStellarLastMileQuoteRequest({ ...request, bankAccount: "private" }),
);

const providers = readStellarPaymentCenterProviderManifests();
assert.equal(providers.length, 1);
assert.equal(providers[0]?.domain, "testanchor.stellar.org");
assert.equal(providers[0]?.referenceOnly, true);
assert.equal(providers[0]?.realWorldSettlement, false);
assert.deepEqual(providers[0]?.expectedCapabilities, ["sep24", "sep38", "sep45"]);
assert.equal(providers[0]?.releaseProbe, null);
assert.equal(providers[0]?.observedProtocolGaps.length, 1);

process.env.STELLAR_LAST_MILE_ENABLED = "true";
process.env.STELLAR_ANCHOR_ALLOWLIST = "https://anchor.example";
process.env.STELLAR_ANCHOR_ENDPOINT_HOST_ALLOWLIST = "";
assert.equal(readStellarLastMileReadiness().paymentCore, "discovery_configured");
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  if (url.pathname === "/.well-known/stellar.toml") {
    return new Response(`
NETWORK_PASSPHRASE = "Test SDF Network ; September 2015"
SIGNING_KEY = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"
TRANSFER_SERVER_SEP0024 = "https://anchor.example/sep24"
DIRECT_PAYMENT_SERVER = "https://anchor.example/sep31"
ANCHOR_QUOTE_SERVER = "https://anchor.example/sep38"
WEB_AUTH_FOR_CONTRACTS_ENDPOINT = "https://anchor.example/sep45/auth"
WEB_AUTH_CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4"
`);
  }
  if (url.pathname === "/sep24/info") {
    return Response.json({
      withdraw: { USDC: { enabled: true, min_amount: 1, max_amount: 10 } },
    });
  }
  if (url.pathname === "/sep38/info") {
    return Response.json({
      assets: [
        {
          asset:
            "stellar:USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        },
        {
          asset: "iso4217:USD",
          country_codes: ["US"],
          buy_delivery_methods: [{ name: "WIRE" }],
        },
      ],
    });
  }
  if (url.pathname === "/sep38/price") {
    assert.equal(url.searchParams.get("context"), "sep24");
    assert.equal(url.searchParams.get("sell_amount"), "5");
    return Response.json({
      price: "1.01",
      total_price: "1.02",
      sell_amount: "5",
      buy_amount: "4.9019607",
      fee: {
        total: "0.05",
        asset:
          "stellar:USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      },
    });
  }
  return new Response("not found", { status: 404 });
};
try {
  const quote = await compareStellarLastMileRoutes({
    sourceNetwork: "stellar_testnet",
    amountMode: "send_exact",
    amount: "5",
    destinationCountry: "US",
    destinationCurrency: "USD",
    deliveryMethod: "WIRE",
  });
  assert.equal(quote.candidates.length, 1);
  assert.equal(quote.candidates[0]?.sep24, true);
  assert.equal(quote.candidates[0]?.settlementMode, "sep24_hosted_withdrawal");
  assert.equal(quote.candidates[0]?.sep31PartnerAdvertised, true);
  assert.equal(quote.candidates[0]?.executionReady, false);
  assert.equal(quote.nextRequiredCapability, "sep45_firm_quote_sep24_execution");

  const providerProbe = await quoteConfiguredStellarPaymentProvider(
    "anchor.example",
    {
      sourceNetwork: "stellar_testnet",
      amountMode: "send_exact",
      amount: "5",
      destinationCountry: "US",
      destinationCurrency: "USD",
      deliveryMethod: "WIRE",
    },
  );
  assert.equal(providerProbe.provider, "anchor.example");
  assert.equal(providerProbe.sep24, true);
  assert.equal(providerProbe.sep38, true);
  assert.equal(providerProbe.sep45Advertised, true);
  assert.equal(providerProbe.mockData, false);

  const overLimit = await compareStellarLastMileRoutes({
    sourceNetwork: "stellar_testnet",
    amountMode: "send_exact",
    amount: "25",
    destinationCountry: "US",
    destinationCurrency: "USD",
    deliveryMethod: "WIRE",
  });
  assert.equal(overLimit.candidates.length, 0);
  assert.match(overLimit.unavailableProviders[0]?.reason || "", /maximum is 10 USDC/u);
} finally {
  globalThis.fetch = originalFetch;
}

console.log("Stellar last-mile boundaries verified.");
