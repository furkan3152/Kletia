"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { JsonRpcProvider, getAddress, keccak256 } = require("ethers");

const BASE_CHAIN_ID = 8_453;
const BLOCKSCOUT_URL = "https://base.blockscout.com";
const projectRoot = path.resolve(__dirname, "../..");
const manifestPath = path.join(
  projectRoot,
  "deployments/base-mainnet-v2.json",
);
const buildInfoDirectory = path.join(projectRoot, "artifacts/build-info");
const targets = [
  {
    manifestKey: "intentRouterV2",
    source: "contracts/v2/core/KletiaIntentRouterV2.sol",
    name: "KletiaIntentRouterV2",
  },
  {
    manifestKey: "launchFactoryV2",
    source: "contracts/v2/launch/KletiaLaunchFactoryV2.sol",
    name: "KletiaLaunchFactoryV2",
  },
  {
    manifestKey: "x402AttestationRegistryV1",
    source: "contracts/v2/registry/KletiaX402ServiceAttestationRegistryV1.sol",
    name: "KletiaX402ServiceAttestationRegistryV1",
  },
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function findBuildInfo(target) {
  const files = fs
    .readdirSync(buildInfoDirectory)
    .filter((file) => file.endsWith(".json"));
  for (const file of files) {
    const value = readJson(path.join(buildInfoDirectory, file));
    const contract = value?.output?.contracts?.[target.source]?.[target.name];
    if (contract?.evm?.deployedBytecode?.object && value?.input) {
      return { value, contract };
    }
  }
  throw new Error(`Hardhat build info missing for ${target.name}.`);
}

function exactRuntimeEvidence(compiledObject, references, liveRuntime, label) {
  const compiled = Buffer.from(compiledObject, "hex");
  const live = Buffer.from(liveRuntime.slice(2), "hex");
  if (compiled.length !== live.length) {
    throw new Error(`${label} runtime length mismatch.`);
  }
  const ignored = new Set();
  for (const entries of Object.values(references || {})) {
    for (const { start, length } of entries) {
      for (let offset = start; offset < start + length; offset += 1) {
        ignored.add(offset);
      }
    }
  }
  for (let index = 0; index < compiled.length; index += 1) {
    if (!ignored.has(index) && compiled[index] !== live[index]) {
      throw new Error(`${label} runtime mismatch outside immutable fields.`);
    }
  }
  return {
    runtimeCodehash: keccak256(liveRuntime),
    byteForByteExactOutsideImmutables: true,
  };
}

async function readVerification(address) {
  const response = await fetch(
    `${BLOCKSCOUT_URL}/api/v2/smart-contracts/${address}`,
    {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!response.ok) {
    throw new Error(`Blockscout contract lookup HTTP ${response.status}.`);
  }
  return response.json();
}

async function submitVerification(address, input, compilerVersion, name) {
  const form = new FormData();
  form.append("compiler_version", compilerVersion);
  form.append("contract_name", name);
  form.append(
    "files[0]",
    new Blob([JSON.stringify(input)], { type: "application/json" }),
    `${name}-standard-input.json`,
  );
  form.append("autodetect_constructor_args", "true");
  form.append("license_type", "mit");
  const response = await fetch(
    `${BLOCKSCOUT_URL}/api/v2/smart-contracts/${address}/verification/via/standard-input`,
    {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Blockscout verification HTTP ${response.status}: ${body.slice(0, 500)}`,
    );
  }
}

async function waitForVerification(address) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const status = await readVerification(address);
    if (status.is_verified === true && status.is_fully_verified === true) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error(`Blockscout verification did not finalize for ${address}.`);
}

async function main() {
  const manifest = readJson(manifestPath);
  if (manifest?.network?.chainId !== BASE_CHAIN_ID) {
    throw new Error("Base V2 deployment manifest has the wrong chain.");
  }
  const provider = new JsonRpcProvider(
    process.env.BASE_RPC_URL?.trim() || "https://base-rpc.publicnode.com",
    BASE_CHAIN_ID,
    { staticNetwork: true },
  );
  const network = await provider.getNetwork();
  if (network.chainId !== BigInt(BASE_CHAIN_ID)) {
    throw new Error(`Wrong live chain: ${network.chainId}.`);
  }

  const evidence = [];
  for (const target of targets) {
    const deployment = manifest.contracts?.[target.manifestKey];
    const address = getAddress(deployment?.address);
    if (deployment.verifiedExact === true) {
      const published = await readVerification(address);
      if (published.is_fully_verified !== true) {
        throw new Error(
          `${target.name} manifest says verified, but Blockscout does not.`,
        );
      }
      evidence.push({
        contract: target.name,
        address,
        runtimeCodehash: deployment.runtimeCodehash,
        manifestExactVerificationReconfirmed: true,
        blockscoutFullyVerified: true,
        sourceLicense: deployment.sourceLicense || "MIT",
        explorerUrl:
          deployment.explorerUrl ||
          `${BLOCKSCOUT_URL}/address/${address}?tab=contract`,
      });
      continue;
    }
    const { value: buildInfo, contract } = findBuildInfo(target);
    const liveRuntime = await provider.getCode(address);
    if (liveRuntime === "0x") {
      throw new Error(`${target.name} has no live runtime code.`);
    }
    const runtime = exactRuntimeEvidence(
      contract.evm.deployedBytecode.object,
      contract.evm.deployedBytecode.immutableReferences,
      liveRuntime,
      target.name,
    );
    if (
      deployment.runtimeCodehash &&
      deployment.runtimeCodehash.toLowerCase() !==
        runtime.runtimeCodehash.toLowerCase()
    ) {
      throw new Error(`${target.name} manifest codehash mismatch.`);
    }

    let verification = await readVerification(address);
    if (verification.is_fully_verified !== true) {
      await submitVerification(
        address,
        buildInfo.input,
        `v${buildInfo.solcLongVersion}`,
        target.name,
      );
      verification = await waitForVerification(address);
    }
    if (verification.is_fully_verified !== true) {
      throw new Error(`${target.name} is not fully verified.`);
    }
    deployment.verifiedExact = true;
    deployment.explorerUrl =
      `${BLOCKSCOUT_URL}/address/${address}?tab=contract`;
    deployment.sourceLicense = "MIT";
    evidence.push({
      contract: target.name,
      address,
      ...runtime,
      blockscoutFullyVerified: true,
      sourceLicense: "MIT",
      explorerUrl: deployment.explorerUrl,
    });
  }

  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o644,
  });
  process.stdout.write(
    `${JSON.stringify({
      status: "verified",
      chainId: BASE_CHAIN_ID,
      contracts: evidence,
    })}\n`,
  );
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      status: "failed_closed",
      error:
        error instanceof Error
          ? error.message.slice(0, 600)
          : "Unknown verification failure.",
    }),
  );
  process.exitCode = 1;
});
