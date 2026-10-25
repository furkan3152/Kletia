import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";

import { isLocalUrl, outboundVerdict } from "../journey-video/lib/guardRules.mjs";
import { videoClock } from "../journey-video/lib/sync.mjs";
import { assertLocalRpcs, base58, signSolanaWire } from "../journey-video/lib/wallet.mjs";

const rpc = (method) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] });

test("the fork guard lets reads and quotes through and refuses every submission to a public host", () => {
  assert.equal(outboundVerdict({ url: "http://127.0.0.1:8545", method: "POST", body: rpc("eth_sendRawTransaction") }).allow, true, "the forks take writes");
  assert.equal(outboundVerdict({ url: "https://api.cow.fi/base/api/v1/account/0x1/orders", method: "GET", body: "" }).allow, true);
  assert.equal(outboundVerdict({ url: "https://api.cow.fi/base/api/v1/quote", method: "POST", body: "{}" }).allow, true);
  assert.equal(outboundVerdict({ url: "https://api.hyperliquid.xyz/info", method: "POST", body: "{}" }).allow, true);
  assert.equal(outboundVerdict({ url: "https://ethereum-rpc.publicnode.com", method: "POST", body: rpc("eth_call") }).allow, true);
  for (const request of [
    { url: "https://api.cow.fi/base/api/v1/orders", method: "POST", body: "{}" },
    { url: "https://clob.polymarket.com/order", method: "POST", body: "{}" },
    { url: "https://clob.polymarket.com/auth/api-key", method: "POST", body: "" },
    { url: "https://api.hyperliquid.xyz/exchange", method: "POST", body: "{}" },
    { url: "https://ethereum-rpc.publicnode.com", method: "POST", body: rpc("eth_sendRawTransaction") },
    { url: "https://api.mainnet-beta.solana.com", method: "POST", body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [] }]) },
    { url: "https://example.com/anything", method: "PUT", body: "" },
  ]) {
    assert.equal(outboundVerdict(request).allow, false, `${request.method} ${request.url}`);
  }
  assert.equal(isLocalUrl("http://localhost:3001/v1"), true);
  assert.equal(isLocalUrl("https://api.kletiaai.xyz"), false);
});

test("the test wallet refuses a signing RPC that is not on 127.0.0.1", () => {
  assert.doesNotThrow(() => assertLocalRpcs({ base: "http://127.0.0.1:8545" }));
  assert.throws(() => assertLocalRpcs({ base: "https://mainnet.base.org" }), /not 127\.0\.0\.1/u);
  assert.throws(() => assertLocalRpcs({ base: "http://localhost:8545" }), /not 127\.0\.0\.1/u);
});

test("base58 matches known encodings", () => {
  assert.equal(base58(new Uint8Array(32)), "11111111111111111111111111111111");
  assert.equal(base58(Uint8Array.from([0, 0, 1])), "112");
  assert.equal(base58(Buffer.from("hello world")), "StV1DL6CwTryKyV");
});

test("a v0 wire transaction is signed in the slot of its signer", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  const other = Buffer.alloc(32, 7);
  // v0 message: prefix, header (1 signer, 0, 1 read-only unsigned), 2 keys, blockhash, 0 instructions, 0 lookups.
  const message = Buffer.concat([Buffer.from([0x80, 1, 0, 1, 2]), raw, other, Buffer.alloc(32, 9), Buffer.from([0, 0])]);
  const wire = Buffer.concat([Buffer.from([1]), Buffer.alloc(64), message]);
  const signed = signSolanaWire(wire, raw, privateKey);
  assert.ok(verify(null, message, publicKey, Buffer.from(signed.subarray(1, 65))));
  assert.deepEqual(Buffer.from(signed.subarray(65)), message, "the message is unchanged");
  assert.throws(() => signSolanaWire(wire, other, privateKey), /not a required signer/u);
});

test("chapter times come from the corner flashes, or map linearly between the title cards", () => {
  assert.equal(videoClock({}, null)(5000), 5000);
  const shifted = videoClock({ start: 4000 }, [[5000, 9000]]);
  assert.equal(shifted(10_000), 15_000);
  const stretched = videoClock({ start: 4000, end: 104_000 }, [[5000, 9000], [119_000, 122_000]]);
  assert.equal(stretched(4000), 9000);
  assert.equal(stretched(104_000), 119_000);
  assert.equal(stretched(54_000), 64_000);
  // Three chapters: opening card, two flashes, closing card.
  const flashed = videoClock({ start: 4000, end: 104_000 }, [[5000, 9000], [20_000, 20_600], [70_000, 70_600], [119_000, 122_000]], 3);
  assert.equal(flashed(0, 0), 0);
  assert.equal(flashed(15_000, 1), 20_000);
  assert.equal(flashed(60_000, 2), 70_000);
});
