/**
 * Dependency-free hashing and encodings shared by receipts, policies, links
 * and previews: a synchronous SHA-256 (FIPS 180-4) so pure builders such as
 * `buildReceipt` stay synchronous, hex and base64url codecs, and UTF-16
 * well-formedness helpers. Cross-checked against Web Crypto and node:crypto
 * in the tests.
 */

const utf8 = new TextEncoder();

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits));

/** SHA-256 of bytes, or of the UTF-8 encoding of a string. */
export function sha256(input: Uint8Array | string): Uint8Array {
  const data = typeof input === "string" ? utf8.encode(input) : input;
  const length = data.length;
  const padded = Math.ceil((length + 9) / 64) * 64;
  const buffer = new Uint8Array(padded);
  buffer.set(data);
  buffer[length] = 0x80;
  const view = new DataView(buffer.buffer);
  const bits = length * 8;
  view.setUint32(padded - 8, Math.floor(bits / 0x1_0000_0000));
  view.setUint32(padded - 4, bits >>> 0);
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded; offset += 64) {
    for (let index = 0; index < 16; index += 1) w[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const a = w[index - 15] as number;
      const b = w[index - 2] as number;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[index] = ((w[index - 16] as number) + s0 + (w[index - 7] as number) + s1) | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let index = 0; index < 64; index += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choose = (e & f) ^ (~e & g);
      const t1 = (h + S1 + choose + (K[index] as number) + (w[index] as number)) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + majority) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + h) | 0;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach((word, index) => outView.setUint32(index * 4, word >>> 0));
  return out;
}

/** Lower-case hex SHA-256 (no prefix). */
export function sha256Hex(input: Uint8Array | string): string {
  return bytesToHex(sha256(input));
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** Hex (with or without `0x`, even length) to bytes; null when malformed. */
export function hexToBytes(value: string): Uint8Array | null {
  const hex = value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/u.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return out;
}

const B64U = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64U_INDEX = new Map<string, number>([...B64U].map((char, index) => [char, index]));

/** RFC 4648 §5 base64url without padding. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] as number;
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    const triple = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += B64U[(triple >>> 18) & 63];
    out += B64U[(triple >>> 12) & 63];
    if (b !== undefined) out += B64U[(triple >>> 6) & 63];
    if (c !== undefined) out += B64U[triple & 63];
  }
  return out;
}

/**
 * Strict base64url (no padding, no other alphabet, canonical trailing bits)
 * to bytes; null when malformed.
 */
export function base64UrlDecode(value: string): Uint8Array | null {
  if (typeof value !== "string" || value.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((value.length * 3) / 4));
  let bits = 0;
  let collected = 0;
  let position = 0;
  for (const char of value) {
    const digit = B64U_INDEX.get(char);
    if (digit === undefined) return null;
    bits = (bits << 6) | digit;
    collected += 6;
    if (collected >= 8) {
      collected -= 8;
      out[position] = (bits >>> collected) & 0xff;
      position += 1;
    }
    bits &= (1 << collected) - 1;
  }
  // Non-zero leftover bits mean a non-canonical encoding.
  if (bits !== 0) return null;
  return out.subarray(0, position);
}

/** True when a string has no lone UTF-16 surrogate. */
export function isWellFormedString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** Replaces every lone surrogate with U+FFFD (String.prototype.toWellFormed). */
export function toWellFormedString(value: string): string {
  if (isWellFormedString(value)) return value;
  let out = "";
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += value[index] + (value[index + 1] as string);
        index += 1;
      } else out += "�";
    } else if (unit >= 0xdc00 && unit <= 0xdfff) out += "�";
    else out += value[index];
  }
  return out;
}

/** Constant-time comparison of two equal-purpose strings (digests, tokens). */
export function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}
