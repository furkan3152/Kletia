// Property tests for the dependency-free primitives every value-moving path
// relies on: decimal <-> base-unit conversion, slippage, base58, base64url,
// hex, SHA-256, keccak-256 / EIP-55 and CAIP identities. Inputs come from a
// seeded generator, so a failure always reproduces; references are
// node:crypto, Buffer and viem.
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import { getAddress, keccak256 } from "viem";
import {
  applySlippage,
  base64UrlDecode,
  base64UrlEncode,
  bytesToHex,
  decodeBase58,
  encodeBase58,
  formatAccountId,
  formatAmount,
  fromBaseUnits,
  hexToBytes,
  isBaseUnitAmount,
  isDecimalAmount,
  isSolanaAddress,
  isSolanaSignature,
  isWellFormedString,
  keccak256Hex,
  parseAccountId,
  parseAssetId,
  sameAccount,
  sameAddressAccount,
  sha256Hex,
  signWebhookPayload,
  timingSafeEqualString,
  verifyWebhookSignature,
  toBaseUnits,
  toChecksumAddress,
  toWellFormedString,
} from "../dist/index.js";

/** mulberry32: small, seeded, good enough to spread inputs. */
function generator(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const int = (min, max) => min + Math.floor(next() * (max - min + 1));
  const bytes = (length) => Uint8Array.from({ length }, () => int(0, 255));
  const digits = (length) => Array.from({ length }, () => String(int(0, 9))).join("");
  return { next, int, bytes, digits };
}

const RUNS = 300;

/* ----------------------------------------------------------- amounts */

test("toBaseUnits and fromBaseUnits round-trip every base-unit amount at every decimals value", () => {
  const random = generator(1);
  for (let run = 0; run < RUNS; run += 1) {
    const decimals = random.int(0, 36);
    const units = BigInt(`${random.int(0, 9)}${random.digits(random.int(0, 60))}`).toString();
    const decimal = fromBaseUnits(units, decimals);
    assert.ok(isDecimalAmount(decimal), decimal);
    assert.equal(toBaseUnits(decimal, decimals), units, `${units} @ ${decimals}`);
    assert.equal(fromBaseUnits(BigInt(units), decimals), decimal);
  }
});

test("toBaseUnits accepts trailing zeros beyond the decimals but never rounds away a significant digit", () => {
  const random = generator(2);
  for (let run = 0; run < RUNS; run += 1) {
    const decimals = random.int(0, 18);
    const whole = String(random.int(0, 1_000_000));
    const fraction = random.digits(decimals);
    const amount = decimals > 0 ? `${whole}.${fraction}` : whole;
    const units = toBaseUnits(amount, decimals);
    assert.equal(toBaseUnits(`${decimals > 0 ? amount : `${whole}.`}${"0".repeat(random.int(1, 5))}`, decimals), units);
    assert.throws(() => toBaseUnits(`${decimals > 0 ? amount : `${whole}.`}${random.int(1, 9)}`, decimals), /exceeds/u);
  }
});

test("decimal and base-unit amounts are plain ASCII digits only", () => {
  for (const bad of ["", " ", "1.", ".5", "01", "00", "-1", "+1", "1e6", "1E6", "0x10", "1_000", "1,5", "١", "１", "Infinity", "NaN", "1.2.3", "1 000"]) {
    assert.equal(isDecimalAmount(bad), false, bad);
    assert.throws(() => toBaseUnits(bad, 6), undefined, bad);
  }
  for (const bad of ["1.0", "01", "-0", "1e3", " 1"]) assert.equal(isBaseUnitAmount(bad), false, bad);
  for (const value of [1, 1n, null, undefined, {}, ["1"]]) {
    assert.equal(isDecimalAmount(value), false);
    assert.equal(isBaseUnitAmount(value), false);
  }
  assert.equal(toBaseUnits("  2.5 ", 1), "25");
  for (const decimals of [-1, 37, 1.5, Number.NaN]) assert.throws(() => toBaseUnits("1", decimals), /decimals/u);
});

test("fromBaseUnits keeps the sign of negative deltas", () => {
  assert.equal(fromBaseUnits(-1_500_000n, 6), "-1.5");
  assert.equal(fromBaseUnits("-1", 0), "-1");
  assert.equal(fromBaseUnits(0n, 9), "0");
});

test("applySlippage rounds down, never exceeds the input and is monotone in the basis points", () => {
  const random = generator(3);
  for (let run = 0; run < RUNS; run += 1) {
    const units = BigInt(`${random.int(1, 9)}${random.digits(random.int(0, 40))}`);
    const low = random.int(0, 10_000);
    const high = random.int(low, 10_000);
    const atLow = BigInt(applySlippage(units.toString(), low));
    const atHigh = BigInt(applySlippage(units.toString(), high));
    assert.ok(atLow <= units && atHigh <= atLow, `${units} ${low} ${high}`);
    assert.equal(atLow, (units * BigInt(10_000 - low)) / 10_000n);
  }
  assert.equal(applySlippage("12345", 0), "12345");
  assert.equal(applySlippage("12345", 10_000), "0");
  assert.equal(applySlippage("9999", 1), "9998");
  for (const bps of [-1, 10_001, 0.5, Number.NaN]) assert.throws(() => applySlippage("1", bps), /slippageBps/u);
});

test("formatAmount groups thousands and clips (never rounds up) the fraction", () => {
  assert.equal(formatAmount("1234567.891"), "1,234,567.891");
  assert.equal(formatAmount("0.9999999"), "0.999999");
  assert.equal(formatAmount("1.0000004"), "1");
  assert.equal(formatAmount("12.34", 0), "12");
  assert.equal(formatAmount("not a number"), "not a number");
  const random = generator(4);
  for (let run = 0; run < RUNS; run += 1) {
    const amount = `${random.int(0, 10 ** 9)}.${random.digits(random.int(1, 18))}`;
    const shown = formatAmount(amount, 4).replace(/,/gu, "");
    assert.ok(Number(shown) <= Number(amount), `${amount} -> ${shown}`);
  }
});

/* ---------------------------------------------------- byte encodings */

test("base58 round-trips random bytes, leading zero bytes included", () => {
  const random = generator(5);
  for (let run = 0; run < RUNS; run += 1) {
    const bytes = new Uint8Array([...new Uint8Array(random.int(0, 3)), ...random.bytes(random.int(0, 70))]);
    const encoded = encodeBase58(bytes);
    assert.deepEqual(decodeBase58(encoded) ?? new Uint8Array(0), bytes);
  }
  for (const bad of ["", "0", "O", "I", "l", "abc+", "11 1"]) assert.equal(decodeBase58(bad), null, bad);
});

test("Solana addresses are exactly 32 bytes and signatures exactly 64 bytes of base58", () => {
  const random = generator(6);
  for (let run = 0; run < 100; run += 1) {
    const key = encodeBase58(random.bytes(32));
    const signature = encodeBase58(random.bytes(64));
    assert.equal(isSolanaAddress(key), true, key);
    assert.equal(isSolanaSignature(key), false);
    assert.equal(isSolanaSignature(signature), true, signature);
    assert.equal(isSolanaAddress(signature), false);
    assert.equal(isSolanaAddress(encodeBase58(random.bytes(31))), false);
    assert.equal(isSolanaAddress(encodeBase58(random.bytes(33))), false);
  }
  assert.equal(isSolanaAddress("11111111111111111111111111111111"), true);
  assert.equal(isSolanaAddress("1111111111111111111111111111111"), false);
});

test("base64url matches Buffer and refuses padding, other alphabets and non-canonical trailing bits", () => {
  const random = generator(7);
  for (let run = 0; run < RUNS; run += 1) {
    const bytes = random.bytes(random.int(0, 80));
    const encoded = base64UrlEncode(bytes);
    assert.equal(encoded, Buffer.from(bytes).toString("base64url"));
    assert.deepEqual(base64UrlDecode(encoded), bytes);
  }
  for (const bad of ["A", "AA==", "AB+/", "A B", "AAAAA", "AB", "AAB"]) assert.equal(base64UrlDecode(bad), null, bad);
  assert.deepEqual(base64UrlDecode("AA"), new Uint8Array([0]));
  assert.deepEqual(base64UrlDecode(""), new Uint8Array(0));
});

test("hex round-trips and refuses odd lengths and non-hex characters", () => {
  const random = generator(8);
  for (let run = 0; run < RUNS; run += 1) {
    const bytes = random.bytes(random.int(0, 64));
    const hex = bytesToHex(bytes);
    assert.deepEqual(hexToBytes(hex), bytes);
    assert.deepEqual(hexToBytes(`0x${hex.toUpperCase()}`), bytes);
  }
  for (const bad of ["0", "0x0", "zz", "0xg0", "12 34"]) assert.equal(hexToBytes(bad), null, bad);
});

/* ---------------------------------------------------------- hashing */

test("sha256 matches node:crypto at every padding boundary and on random input", () => {
  const random = generator(9);
  const lengths = [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 128, ...Array.from({ length: 40 }, () => random.int(0, 600))];
  for (const length of lengths) {
    const bytes = random.bytes(length);
    assert.equal(sha256Hex(bytes), createHash("sha256").update(bytes).digest("hex"), `length ${length}`);
  }
  assert.equal(sha256Hex("héllo ✓"), createHash("sha256").update("héllo ✓", "utf8").digest("hex"));
});

test("keccak-256 matches viem around the 136-byte rate and EIP-55 matches getAddress", () => {
  const random = generator(10);
  for (const length of [0, 1, 135, 136, 137, 271, 272, 273, ...Array.from({ length: 30 }, () => random.int(0, 500))]) {
    const bytes = random.bytes(length);
    assert.equal(keccak256Hex(bytes), keccak256(bytes), `length ${length}`);
  }
  for (let run = 0; run < 100; run += 1) {
    const address = `0x${bytesToHex(random.bytes(20))}`;
    assert.equal(toChecksumAddress(address), getAddress(address));
    assert.equal(toChecksumAddress(address.toUpperCase().replace("0X", "0x")), getAddress(address));
  }
});

test("timingSafeEqualString is plain equality", () => {
  const random = generator(11);
  for (let run = 0; run < RUNS; run += 1) {
    const a = bytesToHex(random.bytes(random.int(0, 8)));
    const b = random.next() < 0.5 ? a : bytesToHex(random.bytes(random.int(0, 8)));
    assert.equal(timingSafeEqualString(a, b), a === b);
  }
});

test("well-formed strings agree with String.prototype.isWellFormed / toWellFormed", () => {
  const random = generator(12);
  for (let run = 0; run < RUNS; run += 1) {
    const text = String.fromCharCode(...Array.from({ length: random.int(0, 12) }, () => (random.next() < 0.3 ? random.int(0xd800, 0xdfff) : random.int(0x20, 0x7e))));
    assert.equal(isWellFormedString(text), text.isWellFormed());
    assert.equal(toWellFormedString(text), text.toWellFormed());
  }
});

/* -------------------------------------------------------------- CAIP */

test("CAIP-10 accounts round-trip; EVM compares case-insensitively, Solana case-sensitively", () => {
  const random = generator(13);
  for (let run = 0; run < 100; run += 1) {
    const evm = getAddress(`0x${bytesToHex(random.bytes(20))}`);
    const id = formatAccountId("base", evm);
    assert.equal(parseAccountId(id)?.id, id);
    assert.equal(sameAccount(id, formatAccountId("base", evm.toLowerCase())), true);
    assert.equal(sameAccount(id, formatAccountId("arbitrum", evm)), false);
    assert.equal(sameAddressAccount(id, formatAccountId("arbitrum", evm)), true);

    const solana = encodeBase58(random.bytes(32));
    const solanaId = formatAccountId("solana", solana);
    assert.equal(parseAccountId(solanaId)?.address, solana);
    const flipped = solana.replace(/[a-km-z]/u, (char) => char.toUpperCase());
    if (flipped !== solana && isSolanaAddress(flipped)) assert.equal(sameAccount(solanaId, formatAccountId("solana", flipped)), false);
    assert.equal(sameAddressAccount(id, solanaId), false);
  }
  for (const bad of [null, "", ":", "eip155:8453", "eip155:8453:0x123", "eip155:999999:0x0000000000000000000000000000000000000001", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:0x0000000000000000000000000000000000000001"]) {
    assert.equal(parseAccountId(bad), null, String(bad));
  }
  assert.throws(() => formatAccountId("solana", "0x0000000000000000000000000000000000000001"));
});

test("CAIP-19 assets accept only the namespace that fits the chain", () => {
  const evm = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  assert.equal(parseAssetId(`eip155:8453/erc20:${evm}`)?.isNative, false);
  assert.equal(parseAssetId("eip155:8453/slip44:60")?.isNative, true);
  assert.equal(parseAssetId(`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:${mint}`)?.reference, mint);
  for (const bad of [
    `eip155:8453/token:${mint}`,
    `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/erc20:${evm}`,
    "eip155:8453/slip44:x",
    "eip155:8453/erc721:0x1",
    "eip155:8453/erc20",
    "/erc20:0x1",
    `eip155:424242/erc20:${evm}`,
    42,
  ]) {
    assert.equal(parseAssetId(bad), null, String(bad));
  }
});

/* ---------------------------------------------------- webhook signatures */

test("webhook signatures are HMAC-SHA256 over t.body and bind secret, body and time window", async () => {
  const random = generator(14);
  const now = 1_800_000_000_000;
  const t = now / 1000;
  for (let run = 0; run < 40; run += 1) {
    const secret = `whsec_${bytesToHex(random.bytes(16))}`;
    const body = JSON.stringify({ id: bytesToHex(random.bytes(8)), n: random.int(0, 1e6), text: "é✓" });
    const header = await signWebhookPayload(secret, body, t);
    assert.equal(header, `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`);
    assert.deepEqual(await verifyWebhookSignature(secret, body, header, { now }), { valid: true, timestamp: t });
    assert.equal((await verifyWebhookSignature(`${secret}x`, body, header, { now })).reason, "mismatch");
    assert.equal((await verifyWebhookSignature(secret, `${body} `, header, { now })).reason, "mismatch");
  }
  const header = await signWebhookPayload("s", "{}", t);
  assert.equal((await verifyWebhookSignature("s", "{}", header, { now: now + 300_000 })).valid, true, "inside the tolerance");
  assert.equal((await verifyWebhookSignature("s", "{}", header, { now: now + 301_000 })).reason, "expired");
  assert.equal((await verifyWebhookSignature("s", "{}", header, { now: now - 301_000 })).reason, "expired", "future timestamps too");
  assert.equal((await verifyWebhookSignature("s", "{}", header, { now: now + 3_600_000, toleranceSeconds: 3_600 })).valid, true);
  const signature = header.split("v1=")[1];
  for (const bad of ["", "t=,v1=", `v1=${signature}`, `t=${t}`, `t=abc,v1=${signature}`, `t=${t},v1=${signature?.toUpperCase()}`, `t=${t},v1=${signature?.slice(1)}`, `t=1.5,v1=${signature}`]) {
    assert.equal((await verifyWebhookSignature("s", "{}", bad, { now })).reason, "malformed", bad);
  }
});
