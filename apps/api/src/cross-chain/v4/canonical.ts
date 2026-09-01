import { createHash } from "node:crypto";

const BN254_SCALAR_FIELD_MODULUS = BigInt(
  "0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001",
);

export function canonicalJsonV4(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry && typeof entry === "object") {
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>)
          .filter(([, nested]) => nested !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, normalize(nested)]),
      );
    }
    return entry;
  };
  return JSON.stringify(normalize(value));
}

export function sha256V4(domain: string, value: unknown): `0x${string}` {
  return `0x${createHash("sha256")
    .update(domain, "utf8")
    .update("\u001f", "utf8")
    .update(canonicalJsonV4(value), "utf8")
    .digest("hex")}`;
}

export function scalarFromMaterialV4(domain: string, value: unknown): `0x${string}` {
  const reduced = BigInt(sha256V4(domain, value)) % BN254_SCALAR_FIELD_MODULUS;
  const nonzero = reduced === 0n ? 1n : reduced;
  return `0x${nonzero.toString(16).padStart(64, "0")}`;
}
