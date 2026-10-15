#!/usr/bin/env node
// Exports the Kletia contract artifacts the admin panel deploys and verifies
// to apps/api/src/admin/contract-artifacts/kletia-contracts.json.
//
//   node tooling/export-contract-artifacts.mjs           # write the file
//   node tooling/export-contract-artifacts.mjs --check   # fail when the committed file is stale
//
// Reads the Hardhat artifacts of contracts/base and contracts/arc (compile
// them first: npm run compile:base && npm run compile:arc) and their
// build-info for the immutable references. Deployable entries carry abi,
// creation bytecode, runtime bytecode, the immutable ranges and
// maskedRuntimeHash = keccak256(runtime with every immutable range zeroed).
// Supporting, legacy and quarantined entries carry the abi only.
//
// The list below must equal the artifact ids of ADMIN_CONTRACTS in
// packages/core/src/admin.ts (a core test checks both).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { keccak256 } from "viem";

const root = resolve(import.meta.dirname, "..");
export const OUTPUT = resolve(root, "apps/api/src/admin/contract-artifacts/kletia-contracts.json");
export const SCHEMA_VERSION = "kletia_contract_artifacts_v1";

/** [artifactId, sourceName, deployable] in output order. */
export const ARTIFACTS = [
  ["base/KletiaIntentRouterV2", "contracts/v2/core/KletiaIntentRouterV2.sol", true],
  ["base/UniswapV2CompatibleAdapter", "contracts/v2/adapters/UniswapV2CompatibleAdapter.sol", true],
  ["base/UniswapV3SwapRouter02Adapter", "contracts/v2/adapters/UniswapV3SwapRouter02Adapter.sol", false],
  ["base/KletiaLaunchFactoryV2", "contracts/v2/launch/KletiaLaunchFactoryV2.sol", true],
  ["base/KletiaX402ServiceAttestationRegistryV1", "contracts/v2/registry/KletiaX402ServiceAttestationRegistryV1.sol", true],
  ["base/X402Factory", "contracts/x402/X402Factory.sol", false],
  ["base/X402Gateway", "contracts/x402/X402Gateway.sol", false],
  ["base/KletiaSmartRouter", "contracts/legacy/KletiaSmartRouter.sol", false],
  ["base/KletiaTokenFactory", "contracts/legacy/KletiaTokenFactory.sol", false],
  ["arc/KletiaArcForwarder", "contracts/KletiaArcForwarder.sol", true],
  ["arc/KletiaToken", "contracts/KletiaToken.sol", true],
  ["arc/KletiaArcSwap", "contracts/KletiaArcSwap.sol", true],
  ["arc/KletiaArcLending", "contracts/KletiaArcLending.sol", true],
  ["arc/KletiaArcStaking", "contracts/KletiaArcStaking.sol", true],
  ["arc/KletiaArcVaultV2", "contracts/KletiaArcVaultV2.sol", true],
  ["arc/KletiaArcVault", "contracts/KletiaArcVault.sol", false],
  ["arc/KletiaArcBatchPay", "contracts/KletiaArcBatchPay.sol", true],
  ["arc/KletiaArcMemoTransfer", "contracts/KletiaArcMemoTransfer.sol", true],
  ["arc/KletiaArcAgentRegistry", "contracts/KletiaArcAgentRegistry.sol", true],
  ["arc/KletiaArcOTC", "contracts/legacy/KletiaArcOTC.sol", false],
];

/** Zeroes every immutable range of a 0x runtime bytecode. */
export function maskImmutables(runtimeHex, ranges) {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/u.test(runtimeHex)) throw new Error("Runtime bytecode must be 0x-prefixed hex.");
  const bytes = Buffer.from(runtimeHex.slice(2), "hex");
  for (const { start, length } of ranges) {
    if (!Number.isInteger(start) || !Number.isInteger(length) || start < 0 || length <= 0 || start + length > bytes.length) {
      throw new Error(`Immutable range ${start}+${length} is outside the runtime bytecode (${bytes.length} bytes).`);
    }
    bytes.fill(0, start, start + length);
  }
  return `0x${bytes.toString("hex")}`;
}

/** Flattens solc's { astId: [{ start, length }] } into ranges sorted by start. */
export function flattenImmutableReferences(references) {
  const ranges = [];
  for (const list of Object.values(references ?? {})) {
    for (const { start, length } of list) ranges.push({ start, length });
  }
  return ranges.sort((a, b) => a.start - b.start || a.length - b.length);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function compilerProfile(buildInfo) {
  const settings = buildInfo.input.settings;
  return {
    solc: buildInfo.solcVersion,
    optimizer: Boolean(settings.optimizer?.enabled),
    runs: settings.optimizer?.enabled ? settings.optimizer.runs ?? 200 : 0,
    evmVersion: settings.evmVersion ?? "paris",
  };
}

/** Builds the export object from the artifact directories (projects root: contracts/). */
export function buildExport(contractsRoot = resolve(root, "contracts")) {
  const artifacts = {};
  for (const [artifactId, sourceName, deployable] of ARTIFACTS) {
    const [project, contractName] = artifactId.split("/");
    const artifactPath = resolve(contractsRoot, project, "artifacts", sourceName, `${contractName}.json`);
    if (!existsSync(artifactPath)) {
      throw new Error(`Missing ${relative(root, artifactPath)}. Compile first: npm run compile:${project}.`);
    }
    const artifact = readJson(artifactPath);
    const debug = readJson(artifactPath.replace(/\.json$/u, ".dbg.json"));
    const buildInfo = readJson(resolve(dirname(artifactPath), debug.buildInfo));
    const output = buildInfo.output.contracts[sourceName]?.[contractName];
    if (!output) throw new Error(`Build info of ${artifactId} has no output for ${sourceName}:${contractName}.`);
    const entry = {
      contractName,
      sourceName,
      project,
      deployable,
      compiler: compilerProfile(buildInfo),
      abi: artifact.abi,
    };
    if (deployable) {
      const ranges = flattenImmutableReferences(output.evm.deployedBytecode.immutableReferences);
      const runtime = artifact.deployedBytecode;
      if (`0x${output.evm.deployedBytecode.object}` !== runtime) {
        throw new Error(`Runtime bytecode of ${artifactId} differs between the artifact and its build info.`);
      }
      Object.assign(entry, {
        bytecode: artifact.bytecode,
        deployedBytecode: runtime,
        immutableReferences: ranges,
        maskedRuntimeHash: keccak256(maskImmutables(runtime, ranges)),
        runtimeHash: keccak256(runtime),
      });
    }
    artifacts[artifactId] = entry;
  }
  return { schemaVersion: SCHEMA_VERSION, artifacts };
}

/** One artifact per line: compact, deterministic and still diffable per contract. */
export function serializeExport(value) {
  const lines = Object.entries(value.artifacts).map(([id, entry]) => `${JSON.stringify(id)}:${JSON.stringify(entry)}`);
  return `{"schemaVersion":${JSON.stringify(value.schemaVersion)},"artifacts":{\n${lines.join(",\n")}\n}}\n`;
}

async function main() {
  const check = process.argv.includes("--check");
  // --output=<path> targets another file (tests); the default is the committed export.
  const outputArg = process.argv.find((arg) => arg.startsWith("--output="));
  const target = outputArg ? resolve(outputArg.slice("--output=".length)) : OUTPUT;
  const text = serializeExport(buildExport());
  if (check) {
    const committed = existsSync(target) ? readFileSync(target, "utf8") : "";
    if (committed !== text) {
      console.error(`${relative(root, target)} is stale. Run: npm run compile:base && npm run compile:arc && npm run export:contract-artifacts`);
      process.exit(1);
    }
    console.log(`${relative(root, target)} is current (${ARTIFACTS.length} artifacts).`);
    return;
  }
  writeFileSync(target, text);
  console.log(`Wrote ${relative(root, target)} (${ARTIFACTS.length} artifacts, ${Buffer.byteLength(text)} bytes).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
