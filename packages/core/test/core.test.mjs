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

test("EIP-55 checksum states on core's own keccak", async () => {
  const { evmChecksumState } = await import("../dist/index.js");
  // EIP-55 test vectors: mixed case verifies; one case only carries no checksum.
  assert.equal(evmChecksumState("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"), "valid");
  assert.equal(evmChecksumState("0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359"), "valid");
  assert.equal(evmChecksumState(EVM_ADDRESS), "valid");
  assert.equal(evmChecksumState("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed"), "uncased");
  assert.equal(evmChecksumState("0x52908400098527886E0F7030069857D2E4169EE7"), "uncased", "all capitals: nothing to check");
  assert.equal(evmChecksumState("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD"), "invalid");
  assert.equal(evmChecksumState("0x52908400098527886E0F7030069857D2E4169Ee7"), "invalid", "one wrong capital");
  assert.equal(evmChecksumState("0x1234"), "invalid");
  assert.equal(evmChecksumState(SOL_ADDRESS), "invalid");
});

test("accounts: a broken mixed-case checksum is refused on the account; lower case passes", () => {
  const broken = validateIntentRequest({ text: "swap 1 ETH to USDC on base", accounts: ["eip155:8453:0x52908400098527886E0F7030069857D2E4169Ee7"] });
  assert.equal(broken.ok, false);
  assert.deepEqual(broken.issues.map((issue) => issue.path), ["accounts[0]"]);
  assert.match(broken.issues[0].message, /checksum/u);
  assert.equal(validateIntentRequest({ text: "x", accounts: ["eip155:8453:0x52908400098527886e0f7030069857d2e4169ee7"] }).ok, true);
});

test("sourceNetwork: a network key or auto, issue path sourceNetwork", () => {
  const accounts = [`eip155:8453:${EVM_ADDRESS}`];
  for (const sourceNetwork of ["auto", "base", "solana", "arbitrum-sepolia"]) {
    const result = validateIntentRequest({ text: "x", accounts, sourceNetwork });
    assert.equal(result.ok, true, sourceNetwork);
    assert.equal(result.value.sourceNetwork, sourceNetwork);
  }
  assert.equal(validateIntentRequest({ text: "x", accounts }).value.sourceNetwork, undefined);
  for (const sourceNetwork of ["AUTO", "mars", 8453, null, ""]) {
    const result = validateIntentRequest({ text: "x", accounts, sourceNetwork });
    assert.equal(result.ok, false, String(sourceNetwork));
    assert.deepEqual(result.issues.map((issue) => issue.path), ["sourceNetwork"]);
  }
});

test("T14: constraints.gasOnArrival takes EVM networks and $0.05-$5.00 strings on one lane", () => {
  const accounts = [`eip155:8453:${EVM_ADDRESS}`];
  const ok = validateIntentRequest({ text: "x", accounts, constraints: { gasOnArrival: { base: "0.05", arbitrum: "5.00", optimism: "1.5" } } });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value.constraints.gasOnArrival, { base: "0.05", arbitrum: "5.00", optimism: "1.5" });
  const refused = [
    [{ base: "0" }, "constraints.gasOnArrival.base"],
    [{ base: "10" }, "constraints.gasOnArrival.base"],
    [{ base: "0.04" }, "constraints.gasOnArrival.base"],
    [{ base: "5.01" }, "constraints.gasOnArrival.base"],
    [{ base: "1.234" }, "constraints.gasOnArrival.base"],
    [{ base: 1 }, "constraints.gasOnArrival.base"],
    [{ solana: "1" }, "constraints.gasOnArrival.solana"],
    [{ unknown: "1" }, "constraints.gasOnArrival.unknown"],
    [{}, "constraints.gasOnArrival"],
    ["1", "constraints.gasOnArrival"],
    [{ base: "1", "arbitrum-sepolia": "1" }, "constraints.gasOnArrival"],
  ];
  for (const [gasOnArrival, path] of refused) {
    const result = validateIntentRequest({ text: "x", accounts, constraints: { gasOnArrival } });
    assert.equal(result.ok, false, JSON.stringify(gasOnArrival));
    assert.ok(result.issues.some((issue) => issue.path === path), `${JSON.stringify(gasOnArrival)}: ${result.issues.map((issue) => issue.path).join(", ")}`);
  }
  // Structured actions fix the lane: a testnet top-up for mainnet actions is refused.
  const lane = validateIntentRequest({
    actions: [{ kind: "bridge", network: "base", from: "USDC", amount: "1", toNetwork: "arbitrum" }],
    accounts,
    constraints: { gasOnArrival: { "arbitrum-sepolia": "1" } },
  });
  assert.equal(lane.ok, false);
  assert.ok(lane.issues.some((issue) => issue.path === "constraints.gasOnArrival"));
});

test("T13: settled + skipped is partially_completed; all skipped is cancelled; all settled completed", () => {
  const step = (id, status) => ({ id, status, mode: "wallet", dependsOn: [] });
  assert.equal(deriveIntentStatus([step("a", "settled"), step("b", "skipped")]), "partially_completed");
  assert.equal(deriveIntentStatus([step("a", "skipped"), step("b", "skipped")]), "cancelled");
  assert.equal(deriveIntentStatus([step("a", "settled"), step("b", "settled")]), "completed");
  assert.equal(deriveIntentStatus([{ ...step("a", "confirmed"), mode: "read" }, step("b", "skipped")]), "partially_completed");
  assert.equal(deriveIntentStatus([step("a", "settled"), step("b", "failed")]), "partially_completed");
  assert.equal(deriveIntentStatus([step("a", "failed"), step("b", "pending")]), "failed");
});

test("round-6 registry assets: EVM liquid staking tokens without a group, USDbC transfer-only", () => {
  for (const symbol of ["wstETH", "rETH", "weETH"]) {
    const asset = findAssetBySymbol("ethereum", symbol);
    assert.ok(asset, symbol);
    assert.equal(asset.category, "liquid-staking");
    assert.equal(asset.decimals, 18);
    assert.equal(asset.group, undefined, `${symbol} is not 1:1 with ETH`);
    assert.equal(asset.transferOnly, undefined);
  }
  const usdbc = findAssetBySymbol("base", "USDbC");
  assert.equal(usdbc.address, "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA");
  assert.equal(usdbc.decimals, 6);
  assert.equal(usdbc.transferOnly, true);
  assert.equal(usdbc.group, undefined, "USDbC is not USDC");
  // Round 7 adds Base weETH as transfer-only (its pools trade far below fair value; protocols design 3.0).
  assert.deepEqual(ASSETS.filter((asset) => asset.transferOnly).map((asset) => `${asset.network}:${asset.symbol}`), ["base:USDbC", "base:weETH"]);
});
