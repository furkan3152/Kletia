#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const FIELD_BYTES = 32;
const MAX_PUBLIC_INPUTS = 32;

function fail(message) {
  throw new Error(message);
}

function field(value, label) {
  let parsed;
  try {
    parsed = BigInt(String(value));
  } catch {
    fail(`${label} is not an integer field element.`);
  }
  if (parsed < 0n) fail(`${label} is negative.`);
  const encoded = parsed.toString(16).padStart(FIELD_BYTES * 2, "0");
  if (encoded.length !== FIELD_BYTES * 2) fail(`${label} exceeds 32 bytes.`);
  return encoded;
}

function g1(point, label) {
  if (!Array.isArray(point) || point.length < 2 || String(point[2]) !== "1") {
    fail(`${label} is not an affine BN254 G1 point.`);
  }
  return `${field(point[0], `${label}.x`)}${field(point[1], `${label}.y`)}`;
}

// snarkjs emits Fp2 coefficients in the Solidity/precompile order. Stellar's
// BN254 host encoding uses c1 || c0 for each affine coordinate, matching the
// already cross-checked Soroban pairing test vector.
function g2(point, label) {
  if (
    !Array.isArray(point) ||
    point.length < 2 ||
    !Array.isArray(point[0]) ||
    !Array.isArray(point[1]) ||
    String(point[2]?.[0]) !== "1" ||
    String(point[2]?.[1]) !== "0"
  ) {
    fail(`${label} is not an affine BN254 G2 point.`);
  }
  return [point[0][1], point[0][0], point[1][1], point[1][0]]
    .map((entry, index) => field(entry, `${label}[${index}]`))
    .join("");
}

function u32(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    fail("The IC length is outside uint32.");
  }
  return value.toString(16).padStart(8, "0");
}

export function prepareVerificationKey(value) {
  if (
    !value ||
    value.protocol !== "groth16" ||
    value.curve !== "bn128" ||
    !Number.isSafeInteger(value.nPublic) ||
    value.nPublic <= 0 ||
    value.nPublic > MAX_PUBLIC_INPUTS ||
    !Array.isArray(value.IC) ||
    value.IC.length !== value.nPublic + 1
  ) {
    fail("The verification key does not match the reviewed Groth16 BN254 shape.");
  }
  const verificationKey = {
    alpha: g1(value.vk_alpha_1, "vk_alpha_1"),
    beta: g2(value.vk_beta_2, "vk_beta_2"),
    delta: g2(value.vk_delta_2, "vk_delta_2"),
    gamma: g2(value.vk_gamma_2, "vk_gamma_2"),
    ic: value.IC.map((point, index) => g1(point, `IC[${index}]`)),
  };
  const contractEncoding = Buffer.from(
    [
      verificationKey.alpha,
      verificationKey.beta,
      verificationKey.gamma,
      verificationKey.delta,
      u32(verificationKey.ic.length),
      ...verificationKey.ic,
    ].join(""),
    "hex",
  );
  return {
    schemaVersion: "kletia_stellar_groth16_constructor_v1",
    publicInputCount: value.nPublic,
    verificationKey,
    verificationKeySha256: createHash("sha256").update(contractEncoding).digest("hex"),
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [, , inputPath, outputPath] = process.argv;
  if (!inputPath || !outputPath) {
    console.error("Usage: node tooling/prepare-stellar-groth16-vk.mjs <snarkjs-vk.json> <constructor.json>");
    process.exit(2);
  }

  const source = JSON.parse(readFileSync(inputPath, "utf8"));
  const prepared = prepareVerificationKey(source);
  writeFileSync(outputPath, `${JSON.stringify(prepared.verificationKey, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  writeFileSync(
    `${outputPath}.manifest.json`,
    `${JSON.stringify({
      schemaVersion: prepared.schemaVersion,
      publicInputCount: prepared.publicInputCount,
      verificationKeySha256: prepared.verificationKeySha256,
    }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  console.log(
    `Prepared ${prepared.publicInputCount} public inputs; vk_sha256=${prepared.verificationKeySha256}`,
  );
}
