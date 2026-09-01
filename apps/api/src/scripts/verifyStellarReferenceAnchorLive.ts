import assert from "node:assert/strict";

process.env.STELLAR_LAST_MILE_ENABLED = "true";
process.env.STELLAR_ANCHOR_ALLOWLIST = "https://testanchor.stellar.org";
process.env.STELLAR_ANCHOR_ENDPOINT_HOST_ALLOWLIST = "";
process.env.STELLAR_ANCHOR_TIMEOUT_MS = "12000";

const [
  {
    compareStellarLastMileRoutes,
    discoverConfiguredPaymentCenterProvider,
  },
  { readStellarPaymentCenterProviderManifests },
  { fetchAndVerifySep45Challenge },
] =
  await Promise.all([
    import("../networks/stellar/lastMile.js"),
    import("../networks/stellar/paymentCenterProviders.js"),
    import("../networks/stellar/payment-center/sep45Challenge.js"),
  ]);

const provider = readStellarPaymentCenterProviderManifests().find(
  (candidate) => candidate.domain === "testanchor.stellar.org",
);
assert(provider, "Testanchor must have a reviewed reference manifest.");
assert.equal(provider.referenceOnly, true);
assert.equal(provider.realWorldSettlement, false);

const discovery = await discoverConfiguredPaymentCenterProvider(provider.domain);
assert.equal(discovery.sep45Advertised, true);
assert(discovery.webAuthContractId);
assert(discovery.signingKey);
const challenge = await fetchAndVerifySep45Challenge({
  passkeyAccount: discovery.webAuthContractId,
  discovery,
});
assert.notEqual(challenge.clientEntryIndex, challenge.serverEntryIndex);
assert.equal(challenge.webAuthContractId, discovery.webAuthContractId);
assert.equal(challenge.signingKey, discovery.signingKey);

const result = await compareStellarLastMileRoutes({
  sourceNetwork: "stellar_testnet",
  amountMode: "send_exact",
  amount: "5",
  destinationCountry: "US",
  destinationCurrency: "USD",
  deliveryMethod: "WIRE",
});

assert.equal(result.mockData, false);
assert.equal(result.candidates.length + result.unavailableProviders.length, 1);
if (result.candidates.length === 1) {
  const candidate = result.candidates[0];
  assert.equal(candidate?.provider, provider.domain);
  assert.equal(candidate?.sep24, true);
  assert.equal(candidate?.quoteType, "indicative");
  assert.equal(candidate?.executionReady, false);
  console.log("Reference anchor now accepts the reviewed SEP-24 quote context; execution remains gated.");
} else {
  assert.equal(result.unavailableProviders[0]?.provider, provider.domain);
  console.log("Reference anchor discovered, but the SEP-24-bound quote remains incompatible and was excluded.");
}

console.log(JSON.stringify({
  provider: provider.domain,
  referenceOnly: provider.referenceOnly,
  realWorldSettlement: provider.realWorldSettlement,
  compatibleCandidates: result.candidates.length,
  unavailableProviders: result.unavailableProviders.length,
  sep45ChallengeVerified: true,
  sep45Authenticated: false,
  firmQuoteCreated: false,
  hostedWithdrawalCreated: false,
  fundedSettlement: false,
  observedAt: new Date().toISOString(),
}));
