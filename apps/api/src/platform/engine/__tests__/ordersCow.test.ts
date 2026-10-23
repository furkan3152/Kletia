/**
 * CoW Protocol order encoding against recorded data: a live limit order from
 * the mainnet orderbook (fixtures/orders/cow-order.json, recorded
 * 2026-10-23 from GET /api/v1/orders/{uid}) must hash to its own uid, its
 * signature must recover to its owner, and its appData to the keccak of its
 * full app data. Also the order type hash from GPv2Order.sol, the guard's
 * refusals, prepare (JSON-RPC answered offline), the orderbook mapping and
 * the relay request.
 *
 *   cd apps/api && node --import tsx --test src/platform/engine/__tests__/ordersCow.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { afterEach, describe, it } from "node:test";
import { decodeAbiParameters, decodeFunctionData, encodeFunctionResult, keccak256, multicall3Abi, parseAbi, toHex, type Hex } from "viem";
import { PlatformError } from "../../errors.js";
import { cowProvider, mapCowOrder } from "../../orders/cow.js";
import {
  COMPOSABLE_COW,
  COW_ORDER_TYPES,
  COW_TWAP_HANDLER,
  GPV2_SETTLEMENT,
  GPV2_VAULT_RELAYER,
  conditionalOrderHash,
  cowAppData,
  cowCancellationTypedData,
  cowOrderDigest,
  cowOrderTypedData,
  cowOrderUid,
  createTwapCalldata,
  invalidateOrderCalldata,
  twapStaticInput,
  type CowOrder,
} from "../../orders/cowProtocol.js";
import { typedDataDigest, verifyTypedDataSignature } from "../../orders/evmGuard.js";
import { planAmounts, planNativeOrder } from "../../orders/plan.js";
import type { PreparedOrderDraft } from "../../orders/types.js";
import { resolveAsset } from "../assets.js";

const fixture = (name: string) => JSON.parse(fs.readFileSync(new URL(`./fixtures/orders/${name}`, import.meta.url), "utf8"));
const recorded = fixture("cow-order.json") as Record<string, string | number | boolean>;

function orderOf(raw: typeof recorded): CowOrder {
  return {
    sellToken: String(raw.sellToken),
    buyToken: String(raw.buyToken),
    receiver: String(raw.receiver),
    sellAmount: String(raw.sellAmount),
    buyAmount: String(raw.buyAmount),
    validTo: Number(raw.validTo),
    appData: String(raw.appData),
    feeAmount: String(raw.feeAmount),
    kind: raw.kind as "sell",
    partiallyFillable: Boolean(raw.partiallyFillable),
    sellTokenBalance: "erc20",
    buyTokenBalance: "erc20",
  };
}

const previousFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = previousFetch;
});

describe("CoW EIP-712 orders", () => {
  it("uses GPv2Order's type hash", () => {
    const type = `Order(${COW_ORDER_TYPES.Order.map((field) => `${field.type} ${field.name}`).join(",")})`;
    // GPv2Order.TYPE_HASH (cowprotocol/contracts src/contracts/libraries/GPv2Order.sol).
    assert.equal(keccak256(toHex(type)), "0xd5a25ba2e97094ad7d83dc28a6572da797d6b3e7fc6663bd93efb789fc17e489");
  });

  it("hashes a recorded mainnet order to its uid", () => {
    const digest = cowOrderDigest(orderOf(recorded), 1);
    assert.equal(cowOrderUid(digest, String(recorded.owner), Number(recorded.validTo)), recorded.uid);
  });

  it("recovers the recorded signature to the order owner and refuses a changed order", async () => {
    const typedData = cowOrderTypedData(orderOf(recorded), 1);
    const digest = typedDataDigest(typedData);
    assert.equal(await verifyTypedDataSignature("ethereum", typedData, digest, String(recorded.owner), recorded.signature, false), recorded.signature);
    const other = "0x1111111111111111111111111111111111111111";
    await assert.rejects(verifyTypedDataSignature("ethereum", typedData, digest, other, recorded.signature, false), (error: unknown) => (error as PlatformError).code === "ORDER_SIGNATURE_MISMATCH");
    const changed = cowOrderTypedData({ ...orderOf(recorded), buyAmount: "1" }, 1);
    const changedDigest = typedDataDigest(changed);
    await assert.rejects(verifyTypedDataSignature("ethereum", changed, changedDigest, String(recorded.owner), recorded.signature, false), (error: unknown) => (error as PlatformError).code === "ORDER_SIGNATURE_MISMATCH");
    await assert.rejects(verifyTypedDataSignature("ethereum", typedData, digest, String(recorded.owner), "0x1234", false), (error: unknown) => (error as PlatformError).code === "ORDER_SIGNATURE_MISMATCH");
  });

  it("hashes app data like the orderbook stores it", () => {
    assert.equal(keccak256(toHex(String(recorded.fullAppData))), recorded.appData);
    const ours = cowAppData("limit");
    assert.equal(ours.json, '{"appCode":"Kletia","metadata":{"orderClass":{"orderClass":"limit"}},"version":"1.15.0"}');
    assert.equal(ours.hash, keccak256(toHex(ours.json)));
  });

  it("builds cancellations and on-chain invalidations for the uid", () => {
    const typed = cowCancellationTypedData([String(recorded.uid)], 1);
    assert.equal(typed.primaryType, "OrderCancellations");
    assert.deepEqual(typed.domain, { name: "Gnosis Protocol", version: "v2", chainId: 1, verifyingContract: GPV2_SETTLEMENT });
    assert.match(typedDataDigest(typed), /^0x[0-9a-f]{64}$/u);
    const call = decodeFunctionData({ abi: parseAbi(["function invalidateOrder(bytes orderUid)"]), data: invalidateOrderCalldata(String(recorded.uid)) });
    assert.equal(call.args[0], recorded.uid);
  });

  it("pins the official addresses", () => {
    assert.equal(GPV2_SETTLEMENT, "0x9008D19f58AAbD9eD0D60971565AA8510560ab41");
    assert.equal(GPV2_VAULT_RELAYER, "0xC92E8bdf79f0507f65a392b0ab4667716BFE0110");
    assert.equal(COMPOSABLE_COW, "0xfdaFc9d1902f4e0b84f65F49f244b32b31013b74");
    assert.equal(COW_TWAP_HANDLER, "0x6cF1e9cA41f7611dEf408122793c358a3d11E5a5");
  });
});

describe("CoW TWAP encoding", () => {
  const data = {
    sellToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    buyToken: "0x4200000000000000000000000000000000000006",
    receiver: "0x0ab2e96e042a7402af586bdd1e12020a0a8011e7",
    partSellAmount: 50_000_000n,
    minPartLimit: 10_000_000_000_000_000n,
    t0: 0n,
    n: 10n,
    t: 86_400n,
    span: 0n,
    appData: cowAppData("twap").hash,
  };

  it("encodes TWAPOrder.Data and createWithContext with the block-timestamp factory", () => {
    const staticInput = twapStaticInput(data);
    const [decoded] = decodeAbiParameters(
      [{ type: "tuple", components: ["sellToken", "buyToken", "receiver", "partSellAmount", "minPartLimit", "t0", "n", "t", "span", "appData"].map((name, index) => ({ name, type: index < 3 ? "address" : index === 9 ? "bytes32" : "uint256" })) }],
      staticInput,
    ) as unknown as [Record<string, unknown>];
    assert.equal(decoded.n, 10n);
    assert.equal(decoded.partSellAmount, 50_000_000n);
    const params = { handler: COW_TWAP_HANDLER, salt: `0x${"ab".repeat(32)}` as Hex, staticInput };
    const call = decodeFunctionData({
      abi: parseAbi(["function createWithContext((address handler, bytes32 salt, bytes staticInput) params, address factory, bytes data, bool dispatch)"]),
      data: createTwapCalldata(params),
    });
    assert.equal(call.args[1], "0x52eD56Da04309Aca4c3FECC595298d80C2f16BAc");
    assert.equal(call.args[3], true);
    assert.match(conditionalOrderHash(params), /^0x[0-9a-f]{64}$/u);
    assert.notEqual(conditionalOrderHash(params), conditionalOrderHash({ ...params, salt: `0x${"cd".repeat(32)}` }));
  });
});

describe("CoW prepare (JSON-RPC answered offline: an account without code and no allowance)", () => {
  const OWNER = "0x0ab2e96e042a7402af586bdd1e12020a0a8011e7";
  const rpc = () => {
    const methods: string[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const zero = `0x${"0".repeat(64)}` as Hex;
      // Reads may arrive batched through Multicall3 aggregate3: every inner call answers zero (no allowance).
      const call = (data: Hex): Hex => {
        if (!data.startsWith("0x82ad56cb")) return zero;
        const { args } = decodeFunctionData({ abi: multicall3Abi, data });
        const calls = args[0] as readonly unknown[];
        return encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: calls.map(() => ({ success: true, returnData: zero })) });
      };
      const answer = (request: { id: number; method: string; params: [{ data: Hex }] }) => {
        methods.push(request.method);
        return { jsonrpc: "2.0", id: request.id, result: request.method === "eth_getCode" ? "0x" : call(request.params[0].data) };
      };
      return new Response(JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return methods;
  };

  async function request(input: Parameters<typeof planNativeOrder>[0]) {
    const plan = planNativeOrder(input);
    const [sell, buy] = await Promise.all([resolveAsset(plan.network, plan.sell), resolveAsset(plan.network, plan.buy)]);
    return { plan, owner: OWNER, sell, buy, ...planAmounts(plan, sell.decimals, buy.decimals) };
  }

  it("prepares an exact approval of the VaultRelayer, then the EIP-712 order whose uid it reports", async () => {
    const methods = rpc();
    const draft = await cowProvider.prepare(await request({ kind: "limit", sell: "WETH", buy: "USDC", amount: "1", price: "4000", network: "base", expiresAt: 1_800_000_000 }));
    assert.ok(methods.includes("eth_getCode"));
    assert.equal(draft.steps.length, 2);
    const [approval, sign] = draft.steps;
    assert.equal(approval?.kind, "evm-transaction");
    const approve = decodeFunctionData({ abi: parseAbi(["function approve(address spender, uint256 amount)"]), data: (approval as { data: Hex }).data });
    assert.deepEqual(approve.args, [GPV2_VAULT_RELAYER, 10n ** 18n]);
    assert.equal(sign?.kind, "eip712");
    const typed = sign?.kind === "eip712" ? sign : null;
    assert.equal(typed?.typedData.message.buyAmount, "4000000000");
    assert.equal(typed?.typedData.message.feeAmount, "0");
    assert.equal(draft.orderId, `cow-protocol:base:${cowOrderUid(typed!.digest, OWNER, 1_800_000_000)}`);
    assert.equal(draft.relay.kind === "cow-create" && draft.relay.signingScheme, "eip712");
  });

  it("marks TWAP unsupported for an account without code, and refuses selling native ETH", async () => {
    rpc();
    await assert.rejects(
      cowProvider.prepare(await request({ kind: "dca", sell: "USDC", buy: "WETH", amount: "100", period: "day", count: 5, network: "base" })),
      (error: unknown) => (error as PlatformError).code === "ORDER_UNSUPPORTED" && (error as PlatformError).details?.reason === "twap-requires-safe",
    );
    await assert.rejects(
      cowProvider.prepare(await request({ kind: "limit", sell: "ETH", buy: "USDC", amount: "1", price: "4000", network: "base" })),
      (error: unknown) => (error as PlatformError).details?.reason === "native-sell",
    );
  });
});

describe("CoW orderbook mapping and relay", () => {
  it("maps recorded account orders (unlisted tokens through the decimals reader)", async () => {
    const asked: string[] = [];
    const order = await mapCowOrder("ethereum", recorded, async (_net, address) => {
      asked.push(address.toLowerCase());
      return 18;
    });
    assert.ok(asked.length <= 2 && asked.every((address) => address === recorded.sellToken || address === recorded.buyToken));
    assert.equal(order.sold.decimals, 18);
    assert.equal(order.id, `cow-protocol:ethereum:${recorded.uid}`);
    assert.equal(order.status, "open");
    assert.equal(order.mechanism, "limit");
    assert.equal(order.cancellable, true);
    assert.equal(order.sell.amount, "500000000000000000");
    assert.equal(order.expiresAt, new Date(Number(recorded.validTo) * 1000).toISOString());
  });

  it("posts exactly the stored order with the signature and checks the returned uid", async () => {
    const order = orderOf(recorded);
    const draft: PreparedOrderDraft = {
      protocol: "cow-protocol",
      action: "create",
      network: "ethereum",
      owner: String(recorded.owner),
      orderId: `cow-protocol:ethereum:${recorded.uid}`,
      steps: [],
      submit: "kletia",
      ttlSeconds: 60,
      warnings: [],
      relay: { kind: "cow-create", order: { ...order, appData: recorded.fullAppData, appDataHash: order.appData, from: recorded.owner }, signingScheme: "eip712" },
    };
    let sent: { url: string; body: Record<string, unknown> } | null = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      sent = { url, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify(recorded.uid), { status: 201 });
    }) as typeof fetch;
    const result = await cowProvider.relay(draft, { signature: String(recorded.signature) });
    assert.deepEqual(result, { orderId: draft.orderId, reference: recorded.uid, status: "submitted" });
    assert.equal(sent!.url, "https://api.cow.fi/mainnet/api/v1/orders");
    assert.equal(sent!.body.signature, recorded.signature);
    assert.equal(sent!.body.signingScheme, "eip712");
    assert.equal(sent!.body.appDataHash, recorded.appData);
    assert.equal(sent!.body.from, recorded.owner);

    globalThis.fetch = (async () => new Response(JSON.stringify(`0x${"00".repeat(56)}`), { status: 201 })) as unknown as typeof fetch;
    await assert.rejects(cowProvider.relay(draft, { signature: String(recorded.signature) }), (error: unknown) => (error as PlatformError).code === "ORDER_RELAY_FAILED");

    globalThis.fetch = (async () => new Response(JSON.stringify({ errorType: "InsufficientAllowance", description: "order owner must give allowance to VaultRelayer" }), { status: 400 })) as unknown as typeof fetch;
    await assert.rejects(cowProvider.relay(draft, { signature: String(recorded.signature) }), (error: unknown) => /allowance to VaultRelayer/u.test((error as Error).message));
  });
});
