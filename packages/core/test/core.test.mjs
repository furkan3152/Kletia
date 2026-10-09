import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSETS,
  CHAINS,
  applySlippage,
  counterpartAsset,
  createEventBus,
  decodeBase58,
  deriveIntentStatus,
  encodeBase58,
  findAssetBySymbol,
  formatAccountId,
  fromBaseUnits,
  isSolanaAddress,
  isSolanaSignature,
  parseAccountId,
  parseAssetId,
  readySteps,
  resolveChain,
  sameAccount,
  sameAddressAccount,
  signWebhookPayload,
  toBaseUnits,
  topologicalOrder,
  validateIntentRequest,
  verifyWebhookSignature,
} from "../dist/index.js";

const SOL_ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const EVM_ADDRESS = "0x000000000000000000000000000000000000dEaD";

test("base58 round-trips 32-byte keys", () => {
  const bytes = decodeBase58(SOL_ADDRESS);
  assert.equal(bytes.length, 32);
  assert.equal(encodeBase58(bytes), SOL_ADDRESS);
  assert.equal(decodeBase58("0OIl"), null);
});

test("address validation is namespace aware", () => {
  assert.ok(isSolanaAddress(SOL_ADDRESS));
  assert.ok(isSolanaAddress("11111111111111111111111111111111"));
  assert.ok(!isSolanaAddress(EVM_ADDRESS));
  assert.ok(!isSolanaAddress("abc"));
  assert.ok(!isSolanaSignature(SOL_ADDRESS));
});

test("chains resolve from keys, CAIP-2 ids, aliases and EVM ids", () => {
  assert.equal(resolveChain("base").id, "eip155:8453");
  assert.equal(resolveChain(42161).key, "arbitrum");
  assert.equal(resolveChain("8453").key, "base");
  assert.equal(resolveChain("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp").key, "solana");
  assert.equal(resolveChain("devnet").key, "solana-devnet");
  assert.equal(resolveChain("stellar"), null);
});

test("CAIP-10 accounts format, parse and compare", () => {
  const evm = formatAccountId("base", EVM_ADDRESS);
  assert.equal(evm, `eip155:8453:${EVM_ADDRESS}`);
  assert.equal(parseAccountId(evm).chain.key, "base");
  assert.ok(sameAccount(evm, `eip155:8453:${EVM_ADDRESS.toLowerCase()}`));
  assert.ok(!sameAccount(evm, `eip155:42161:${EVM_ADDRESS}`), "sameAccount is chain-exact");
  assert.ok(sameAddressAccount(evm, `eip155:42161:${EVM_ADDRESS.toLowerCase()}`), "same EVM address on another eip155 network");
  assert.ok(!sameAddressAccount(evm, "eip155:42161:0x000000000000000000000000000000000000bEEF"));
  assert.ok(!sameAddressAccount(evm, "not-an-account"));
  const sol = formatAccountId("solana", SOL_ADDRESS);
  assert.equal(parseAccountId(sol).address, SOL_ADDRESS);
  assert.equal(parseAccountId(`eip155:8453:${SOL_ADDRESS}`), null);
  assert.throws(() => formatAccountId("solana", EVM_ADDRESS));
});

test("CAIP-19 assets parse and registry is internally consistent", () => {
  for (const asset of ASSETS) {
    const parsed = parseAssetId(asset.id);
    assert.ok(parsed, asset.id);
    assert.equal(parsed.chain.key, asset.network);
    assert.equal(parsed.isNative, asset.address === null);
  }
  assert.equal(new Set(ASSETS.map((asset) => asset.id)).size, ASSETS.length);
  const usdcBase = findAssetBySymbol("base", "usdc");
  assert.equal(counterpartAsset(usdcBase, "solana").symbol, "USDC");
  assert.equal(findAssetBySymbol("solana", "SOL").decimals, 9);
});

test("amount conversions are exact", () => {
  assert.equal(toBaseUnits("1.5", 6), "1500000");
  assert.equal(toBaseUnits("0.000000001", 9), "1");
  assert.equal(toBaseUnits("10.0", 6), "10000000");
  assert.throws(() => toBaseUnits("0.0000001", 6));
  assert.throws(() => toBaseUnits("-1", 6));
  assert.equal(fromBaseUnits("1500000", 6), "1.5");
  assert.equal(fromBaseUnits(1n, 9), "0.000000001");
  assert.equal(applySlippage("1000000", 50), "995000");
});

function step(id, status, dependsOn = []) {
  return { id, index: 0, status, dependsOn, mode: "wallet", network: "base", evidence: [] };
}

test("lifecycle derives status and ready steps", () => {
  const steps = [step("a", "settled"), step("b", "pending", ["a"]), step("c", "pending", ["b"])];
  assert.deepEqual(readySteps(steps).map((s) => s.id), ["b"]);
  assert.equal(deriveIntentStatus(steps), "executing");
  assert.equal(deriveIntentStatus([step("a", "pending")]), "planned");
  assert.equal(deriveIntentStatus([step("a", "settled"), step("b", "failed")]), "partially_completed");
  assert.equal(deriveIntentStatus([step("a", "settled")]), "completed");
  assert.equal(deriveIntentStatus([step("a", "pending")], new Date(0).toISOString()), "expired");
  assert.throws(() => topologicalOrder([step("a", "pending", ["b"]), step("b", "pending", ["a"])]));
});

test("request validation accepts mixed EVM and Solana accounts", () => {
  const ok = validateIntentRequest({
    text: "bridge 10 USDC from base to solana",
    accounts: [formatAccountId("base", EVM_ADDRESS), formatAccountId("solana", SOL_ADDRESS)],
    constraints: { maxSlippageBps: 50 },
  });
  assert.equal(ok.ok, true);
  const bad = validateIntentRequest({ accounts: ["nope"], constraints: { maxSlippageBps: 5000 } });
  assert.equal(bad.ok, false);
  assert.ok(bad.issues.length >= 3);
});

test("webhook signatures verify and reject tampering", async () => {
  const body = JSON.stringify({ type: "intent.created" });
  const header = await signWebhookPayload("whsec_test", body, 1_700_000_000);
  const valid = await verifyWebhookSignature("whsec_test", body, header, { now: 1_700_000_010_000 });
  assert.equal(valid.valid, true);
  const tampered = await verifyWebhookSignature("whsec_test", `${body} `, header, { now: 1_700_000_010_000 });
  assert.equal(tampered.reason, "mismatch");
  const expired = await verifyWebhookSignature("whsec_test", body, header, { now: 1_800_000_000_000 });
  assert.equal(expired.reason, "expired");
});

test("webhook verification accepts Node/Express header values (string | string[])", async () => {
  const body = JSON.stringify({ type: "intent.created" });
  const header = await signWebhookPayload("whsec_test", body, 1_700_000_000);
  const options = { now: 1_700_000_010_000 };
  assert.equal((await verifyWebhookSignature("whsec_test", body, [header], options)).valid, true);
  assert.equal((await verifyWebhookSignature("whsec_test", body, [header, "t=1,v1=00"], options)).valid, true);
  assert.equal((await verifyWebhookSignature("whsec_test", body, [], options)).reason, "malformed");
  assert.equal((await verifyWebhookSignature("whsec_test", body, undefined, options)).reason, "malformed");
});

test("event bus isolates listener failures", () => {
  const errors = [];
  const bus = createEventBus((error) => errors.push(error));
  const seen = [];
  bus.on("x", () => { throw new Error("boom"); });
  bus.on("x", (payload) => seen.push(payload));
  bus.onAny((type) => seen.push(type));
  bus.emit("x", 1);
  assert.deepEqual(seen, [1, "x"]);
  assert.equal(errors.length, 1);
});

test("every chain declares a unique CAIP-2 id", () => {
  const ids = Object.values(CHAINS).map((chain) => chain.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("round-5 event types and registry flags", async () => {
  const { KEY_EVENT_TYPES, LINK_EVENT_TYPES, POLICY_EVENT_TYPES, RECEIPT_EVENT_TYPE, getAsset } = await import("../dist/index.js");
  assert.equal(RECEIPT_EVENT_TYPE, "intent.receipt_issued");
  assert.deepEqual(LINK_EVENT_TYPES, ["link.created", "link.activated", "link.updated", "link.paused", "link.suspended", "link.exhausted", "link.expired", "link.deleted"]);
  assert.deepEqual(POLICY_EVENT_TYPES, ["policy.violation", "policy.approval_requested", "policy.approval_decided", "policy.amendment_pending", "policy.amended", "policy.spend_threshold"]);
  assert.deepEqual(KEY_EVENT_TYPES, ["key.created", "key.revoked"]);
  const arcUsdc = ASSETS.find((asset) => asset.network === "arc" && asset.symbol === "USDC");
  assert.equal(arcUsdc.nativeBalanceView, true, "Arc USDC is a view of the native balance");
  assert.equal(getAsset(arcUsdc.id), arcUsdc);
  assert.equal(ASSETS.filter((asset) => asset.nativeBalanceView).length, 1);
});
