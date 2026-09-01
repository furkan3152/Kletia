import assert from "node:assert/strict";

import {
  parseStellarMppPriceAtomic,
  validateStellarMppConfiguration,
} from "../networks/stellar/mpp.js";
import { STELLAR_TESTNET } from "../networks/stellar/config.js";

const recipient = STELLAR_TESTNET.usdc.issuer;
const secretKey = "x".repeat(32);

assert.equal(parseStellarMppPriceAtomic("0"), null);
assert.equal(parseStellarMppPriceAtomic("0.0000001"), 1n);
assert.equal(parseStellarMppPriceAtomic("100"), 1_000_000_000n);
assert.equal(parseStellarMppPriceAtomic("100.0000001"), null);
assert.equal(parseStellarMppPriceAtomic("1.00000000"), null);

const readyConfiguration = validateStellarMppConfiguration({
  enabled: true,
  recipient,
  secretKey,
  price: "0.01",
  databaseConfigured: true,
});
assert.equal(readyConfiguration.valid, true);
assert.equal(readyConfiguration.priceAtomic, "100000");
assert.equal(readyConfiguration.unsignedPushAccepted, false);
assert.equal(readyConfiguration.sessionMode, "disabled_until_channel_contract_is_pinned");

for (const invalid of [
  { ...readyConfiguration, enabled: false },
  { ...readyConfiguration, recipient: "invalid" },
  { ...readyConfiguration, secretKey: "short" },
  { ...readyConfiguration, price: "0" },
  { ...readyConfiguration, databaseConfigured: false },
]) {
  const checked = validateStellarMppConfiguration({
    enabled: invalid.enabled,
    recipient: invalid.recipient ?? "",
    secretKey: "secretKey" in invalid ? String(invalid.secretKey) : secretKey,
    price: invalid.price ?? "0.01",
    databaseConfigured: invalid.databaseConfigured,
  });
  assert.equal(checked.valid, false);
}

console.log("Stellar MPP charge configuration and price boundaries verified.");
