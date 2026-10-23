/**
 * The MessagePack subset Hyperliquid hashes L1 actions with (python
 * `msgpack.packb`, as in hyperliquid-python-sdk `action_hash`): nil, booleans,
 * non-negative integers in their smallest form, UTF-8 strings, arrays and
 * string-keyed maps in insertion order. Anything else is refused, so an
 * action can never hash differently from what the exchange recomputes.
 */
export type MsgpackValue = null | boolean | number | bigint | string | readonly MsgpackValue[] | { readonly [key: string]: MsgpackValue };

const encoder = new TextEncoder();

function header(bytes: number[], fix: number, fixMax: number, codes: readonly [number, number, number], length: number): void {
  if (length <= fixMax) bytes.push(fix | length);
  else if (length < 0x100 && codes[0] !== 0) bytes.push(codes[0], length);
  else if (length < 0x10000) bytes.push(codes[1], length >> 8, length & 0xff);
  else bytes.push(codes[2], (length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff);
}

function encodeInteger(bytes: number[], value: bigint): void {
  if (value < 0n) throw new TypeError("Hyperliquid actions carry no negative integers.");
  if (value < 0x80n) bytes.push(Number(value));
  else if (value < 0x100n) bytes.push(0xcc, Number(value));
  else if (value < 0x10000n) bytes.push(0xcd, Number(value >> 8n), Number(value & 0xffn));
  else if (value < 0x1_0000_0000n) bytes.push(0xce, ...[24n, 16n, 8n, 0n].map((shift) => Number((value >> shift) & 0xffn)));
  else if (value < 1n << 64n) bytes.push(0xcf, ...[56n, 48n, 40n, 32n, 24n, 16n, 8n, 0n].map((shift) => Number((value >> shift) & 0xffn)));
  else throw new TypeError("Integer above 64 bits.");
}

function encodeInto(bytes: number[], value: MsgpackValue): void {
  if (value === null) bytes.push(0xc0);
  else if (value === false) bytes.push(0xc2);
  else if (value === true) bytes.push(0xc3);
  else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("Hyperliquid actions carry integers only (prices and sizes are strings).");
    encodeInteger(bytes, BigInt(value));
  } else if (typeof value === "bigint") encodeInteger(bytes, value);
  else if (typeof value === "string") {
    const utf8 = encoder.encode(value);
    header(bytes, 0xa0, 31, [0xd9, 0xda, 0xdb], utf8.length);
    bytes.push(...utf8);
  } else if (Array.isArray(value)) {
    header(bytes, 0x90, 15, [0, 0xdc, 0xdd], value.length);
    for (const entry of value as readonly MsgpackValue[]) encodeInto(bytes, entry);
  } else {
    const entries = Object.entries(value as { readonly [key: string]: MsgpackValue });
    header(bytes, 0x80, 15, [0, 0xde, 0xdf], entries.length);
    for (const [key, entry] of entries) {
      encodeInto(bytes, key);
      encodeInto(bytes, entry);
    }
  }
}

export function encodeMsgpack(value: MsgpackValue): Uint8Array {
  const bytes: number[] = [];
  encodeInto(bytes, value);
  return Uint8Array.from(bytes);
}
