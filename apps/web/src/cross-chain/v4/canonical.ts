import { sha256 } from "@noble/hashes/sha256";

const encoder = new TextEncoder();
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

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function sha256V4(domain: string, value: unknown): `0x${string}` {
  return `0x${bytesToHex(sha256(encoder.encode(
    `${domain}\u001f${canonicalJsonV4(value)}`,
  )))}`;
}

export function scalarFromMaterialV4(domain: string, value: unknown): bigint {
  const reduced = BigInt(sha256V4(domain, value)) % BN254_SCALAR_FIELD_MODULUS;
  return reduced === 0n ? 1n : reduced;
}

export function scalarHexV4(value: bigint): `0x${string}` {
  if (value <= 0n || value >= BN254_SCALAR_FIELD_MODULUS) {
    throw new Error("A Policy V2 value is outside the canonical BN254 scalar field.");
  }
  return `0x${value.toString(16).padStart(64, "0")}`;
}

export function randomScalarV4(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  value %= BN254_SCALAR_FIELD_MODULUS;
  return value === 0n ? 1n : value;
}

export function randomBytes32HexV4(): `0x${string}` {
  return `0x${bytesToHex(crypto.getRandomValues(new Uint8Array(32)))}`;
}

