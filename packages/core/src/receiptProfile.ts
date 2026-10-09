/**
 * The receipt JSON profile (receipts design §5.1): RFC 8785 JCS over a
 * restricted value space so every conforming JCS implementation agrees byte
 * for byte.
 *
 * 1. Only null, booleans, strings, arrays, plain objects and safe integers
 *    (|n| ≤ 2^53 − 1). No fractions, exponents, NaN, Infinity or −0: amounts,
 *    USD values, block numbers and slots above 2^53 travel as decimal strings.
 * 2. Strings are well-formed UTF-16 (no lone surrogates). Control characters
 *    are allowed (JCS and Python's json.dumps escape them identically).
 * 3. Object keys match `^[A-Za-z0-9_.:-]{1,64}$` (fixed schema keys; user-keyed
 *    maps travel as arrays of pairs), so UTF-16 and code-point key orders agree.
 * 4. No undefined, no non-plain objects (Date, Map, class instances), no bigint.
 *
 * Unlike `canonicalJson` (contracts.ts) this never coerces: a breach throws a
 * `ReceiptProfileError` with the JSON path of the offending value.
 */
import { isWellFormedString } from "./hash.js";

export const RECEIPT_PROFILE_KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/u;

export class ReceiptProfileError extends Error {
  readonly code = "PROFILE_VIOLATION" as const;
  /** JSON path of the offending value, e.g. `$.steps[1].index`. */
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ReceiptProfileError";
    this.path = path;
  }
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function serialize(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value)) {
        throw new ReceiptProfileError(path, "only safe integers are allowed; send fractions and large numbers as decimal strings.");
      }
      if (Object.is(value, -0)) throw new ReceiptProfileError(path, "-0 is not allowed.");
      return String(value);
    case "string":
      if (!isWellFormedString(value)) throw new ReceiptProfileError(path, "string contains a lone surrogate.");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        const parts: string[] = [];
        for (let index = 0; index < value.length; index += 1) parts.push(serialize(value[index], `${path}[${index}]`));
        return `[${parts.join(",")}]`;
      }
      if (!isPlainObject(value)) throw new ReceiptProfileError(path, "only plain objects are allowed.");
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record);
      for (const key of keys) {
        if (!RECEIPT_PROFILE_KEY_PATTERN.test(key)) throw new ReceiptProfileError(path, `key ${JSON.stringify(key)} is outside the receipt profile.`);
        if (record[key] === undefined) throw new ReceiptProfileError(`${path}.${key}`, "undefined is not allowed.");
      }
      // RFC 8785 §3.2.3: sort by UTF-16 code units (the default string sort).
      keys.sort();
      return `{${keys.map((key) => `${JSON.stringify(key)}:${serialize(record[key], `${path}.${key}`)}`).join(",")}}`;
    }
    default:
      throw new ReceiptProfileError(path, `${typeof value} is not allowed.`);
  }
}

/** RFC 8785 JCS of a value inside the receipt profile; throws ReceiptProfileError otherwise. */
export function receiptJcs(value: unknown): string {
  return serialize(value, "$");
}

/** True when `value` is inside the receipt profile. */
export function isReceiptProfileValue(value: unknown): boolean {
  try {
    serialize(value, "$");
    return true;
  } catch {
    return false;
  }
}
