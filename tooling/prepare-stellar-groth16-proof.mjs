#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";

const FIELD_BYTES = 32;
const MAX_PUBLIC_INPUTS = 32;

function field(value, label) {
  let parsed;
  try {
    parsed = BigInt(String(value));
  } catch {
    throw new Error(`${label} is not an integer field element.`);
  }
  if (parsed < 0n) throw new Error(`${label} is negative.`);
  const encoded = parsed.toString(16).padStart(FIELD_BYTES * 2, "0");
  if (encoded.length !== FIELD_BYTES * 2) {
    throw new Error(`${label} exceeds 32 bytes.`);
  }
  return encoded;
}

function g1(point, label) {
  if (!Array.isArray(point) || point.length < 2 || String(point[2]) !== "1") {
    throw new Error(`${label} is not an affine BN254 G1 point.`);
  }
  return `${field(point[0], `${label}.x`)}${field(point[1], `${label}.y`)}`;
}

function g2(point, label) {
  if (
    !Array.isArray(point) ||
    point.length < 2 ||
    !Array.isArray(point[0]) ||
    !Array.isArray(point[1]) ||
    String(point[2]?.[0]) !== "1" ||
    String(point[2]?.[1]) !== "0"
  ) {
    throw new Error(`${label} is not an affine BN254 G2 point.`);
  }
  return [point[0][1], point[0][0], point[1][1], point[1][0]]
    .map((entry, index) => field(entry, `${label}[${index}]`))
    .join("");
}

const [, , proofPath, publicPath, outputPrefix] = process.argv;
if (!proofPath || !publicPath || !outputPrefix) {
  console.error(
    "Usage: node tooling/prepare-stellar-groth16-proof.mjs <proof.json> <public.json> <output-prefix>",
  );
  process.exit(2);
}

const proof = JSON.parse(readFileSync(proofPath, "utf8"));
const publicSignals = JSON.parse(readFileSync(publicPath, "utf8"));
if (
  proof.protocol !== "groth16" ||
  proof.curve !== "bn128" ||
  !Array.isArray(publicSignals) ||
  publicSignals.length <= 0 ||
  publicSignals.length > MAX_PUBLIC_INPUTS
) {
  throw new Error("The proof does not match the supported Kletia Groth16 BN254 shape.");
}

const proofBytes = Buffer.from(
  `${g1(proof.pi_a, "pi_a")}${g2(proof.pi_b, "pi_b")}${g1(proof.pi_c, "pi_c")}`,
  "hex",
);
if (proofBytes.length !== 256) throw new Error("The encoded proof is not 256 bytes.");
const encodedPublic = publicSignals.map((entry, index) =>
  field(entry, `publicSignals[${index}]`),
);

writeFileSync(`${outputPrefix}.proof.bin`, proofBytes, { mode: 0o600 });
writeFileSync(
  `${outputPrefix}.public.json`,
  `${JSON.stringify(encodedPublic, null, 2)}\n`,
  { encoding: "utf8", mode: 0o600 },
);
writeFileSync(
  `${outputPrefix}.envelope.json`,
  `${JSON.stringify({
    schemaVersion: "kletia_policy_proof_transport_v1",
    proof: `0x${proofBytes.toString("hex")}`,
    publicInputs: encodedPublic.map((entry) => `0x${entry}`),
  }, null, 2)}\n`,
  { encoding: "utf8", mode: 0o600 },
);
console.log(`Prepared ${proofBytes.length}-byte proof with ${encodedPublic.length} public inputs.`);
