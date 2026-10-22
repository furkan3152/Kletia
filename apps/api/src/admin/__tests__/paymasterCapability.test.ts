// The sponsored-gas capability (GAPS 3.23): live only when the proxy can reach CDP, through
// CDP_PAYMASTER_URL or the URL derived from CDP_API_KEY_ID, and it never asks for both.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { readFeatureCapabilities } from "../../release/capabilities.js";

const KEYS = ["PAYMASTER_PROXY_ENABLED", "CDP_PAYMASTER_POLICY_ID", "CDP_PAYMASTER_URL", "CDP_API_KEY_ID"] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function paymaster(env: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, env);
  const found = readFeatureCapabilities().features.find((entry) => entry.id === "base.paymaster");
  assert.ok(found);
  return found;
}

test("live with the policy and CDP_API_KEY_ID alone (no CDP_PAYMASTER_URL)", () => {
  assert.equal(paymaster({ PAYMASTER_PROXY_ENABLED: "true", CDP_PAYMASTER_POLICY_ID: "policy", CDP_API_KEY_ID: "abcdefgh12" }).state, "live");
  assert.equal(paymaster({ PAYMASTER_PROXY_ENABLED: "true", CDP_PAYMASTER_POLICY_ID: "policy", CDP_PAYMASTER_URL: "https://api.developer.coinbase.com/rpc/v1/base/x" }).state, "live");
});

test("fails closed without a provider, a policy or the switch, and names the either-or variable", () => {
  const missingProvider = paymaster({ PAYMASTER_PROXY_ENABLED: "true", CDP_PAYMASTER_POLICY_ID: "policy" });
  assert.equal(missingProvider.state, "needs_configuration");
  assert.deepEqual(missingProvider.requires, ["PAYMASTER_PROXY_ENABLED=true", "CDP_PAYMASTER_POLICY_ID", "CDP_API_KEY_ID (or CDP_PAYMASTER_URL)"]);
  assert.equal(paymaster({ PAYMASTER_PROXY_ENABLED: "true", CDP_API_KEY_ID: "abcdefgh12" }).state, "needs_configuration");
  assert.equal(paymaster({ CDP_PAYMASTER_POLICY_ID: "policy", CDP_API_KEY_ID: "abcdefgh12" }).state, "needs_configuration");
});
