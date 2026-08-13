const fs = require("node:fs");
const path = require("node:path");
const solc = require("solc");
const {
  JsonRpcProvider,
  Contract,
  getAddress,
  keccak256,
  zeroPadValue,
} = require("ethers");

const BASE_CHAIN_ID = 8_453;
const FACTORY_ADDRESS = "0xD6e7bAc04a9969f75AEA3f17b5b82db1C988DD46";
const BLOCKSCOUT_URL = "https://base.blockscout.com";
const COMPILER_VERSION = "v0.8.20+commit.a1b79de6";
const projectRoot = path.resolve(__dirname, "../..");

function source(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

function verificationInput() {
  return {
    language: "Solidity",
    sources: {
      "contracts/X402Gateway.sol": {
        content: source("contracts/x402/X402Gateway.sol"),
      },
      "@openzeppelin/contracts/utils/Context.sol": {
        content: source("node_modules/@openzeppelin/contracts/utils/Context.sol"),
      },
      "@openzeppelin/contracts/access/Ownable.sol": {
        content: source("node_modules/@openzeppelin/contracts/access/Ownable.sol"),
      },
      "@openzeppelin/contracts/token/ERC20/IERC20.sol": {
        content: source("node_modules/@openzeppelin/contracts/token/ERC20/IERC20.sol"),
      },
    },
    settings: {
      evmVersion: "paris",
      libraries: {},
      optimizer: { enabled: true, runs: 200 },
      outputSelection: {
        "*": {
          "": ["*"],
          "*": ["abi", "evm.deployedBytecode.object", "evm.deployedBytecode.immutableReferences"],
        },
      },
    },
  };
}

function compile(input) {
  if (solc.version() !== "0.8.20+commit.a1b79de6.Emscripten.clang") {
    throw new Error(`Wrong solc package: ${solc.version()}`);
  }
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors || []).filter(({ severity }) => severity === "error");
  if (errors.length > 0) {
    throw new Error(errors.map(({ formattedMessage }) => formattedMessage).join("\n"));
  }
  const contract = output.contracts["contracts/X402Gateway.sol"].X402Gateway;
  if (!contract?.evm?.deployedBytecode?.object) {
    throw new Error("X402Gateway runtime bytecode was empty.");
  }
  return contract;
}

function materializeRuntime(contract, usdc) {
  let runtime = contract.evm.deployedBytecode.object;
  const immutableValue = zeroPadValue(getAddress(usdc), 32).slice(2);
  const references = Object.values(
    contract.evm.deployedBytecode.immutableReferences || {},
  ).flat();
  if (references.length === 0 || references.some(({ length }) => length !== 32)) {
    throw new Error("Unexpected X402Gateway immutable layout.");
  }
  for (const { start, length } of references) {
    runtime =
      runtime.slice(0, start * 2) +
      immutableValue.slice(64 - length * 2) +
      runtime.slice((start + length) * 2);
  }
  return `0x${runtime}`;
}

async function readVerification(address) {
  const response = await fetch(
    `${BLOCKSCOUT_URL}/api/v2/smart-contracts/${address}`,
    { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) },
  );
  if (!response.ok) {
    throw new Error(`Blockscout contract lookup HTTP ${response.status}.`);
  }
  return response.json();
}

async function submitVerification(address, input) {
  const form = new FormData();
  form.append("compiler_version", COMPILER_VERSION);
  form.append("contract_name", "X402Gateway");
  form.append(
    "files[0]",
    new Blob([JSON.stringify(input)], { type: "application/json" }),
    "x402-gateway-standard-input.json",
  );
  form.append("autodetect_constructor_args", "true");
  form.append("license_type", "mit");
  const response = await fetch(
    `${BLOCKSCOUT_URL}/api/v2/smart-contracts/${address}/verification/via/standard-input`,
    { method: "POST", body: form, signal: AbortSignal.timeout(30_000) },
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Blockscout verification HTTP ${response.status}: ${body.slice(0, 500)}`,
    );
  }
}

async function waitForVerification(address) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const status = await readVerification(address);
    if (status.is_verified === true && status.is_fully_verified === true) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error(`Blockscout verification did not finalize for ${address}.`);
}

async function main() {
  const input = verificationInput();
  const compiled = compile(input);
  const provider = new JsonRpcProvider(
    process.env.BASE_RPC_URL?.trim() || "https://base-rpc.publicnode.com",
    BASE_CHAIN_ID,
    { staticNetwork: true },
  );
  const factory = new Contract(
    FACTORY_ADDRESS,
    [
      "function allGatewaysLength() view returns (uint256)",
      "function allGateways(uint256) view returns (address)",
    ],
    provider,
  );
  const gatewayAbi = [
    "function usdc() view returns (address)",
    "function owner() view returns (address)",
    "function pricePerCall() view returns (uint256)",
  ];
  const count = await factory.allGatewaysLength();
  const evidence = [];
  for (let index = 0n; index < count; index += 1n) {
    const address = getAddress(await factory.allGateways(index));
    const gateway = new Contract(address, gatewayAbi, provider);
    const [liveRuntime, usdc, owner, price] = await Promise.all([
      provider.getCode(address),
      gateway.usdc(),
      gateway.owner(),
      gateway.pricePerCall(),
    ]);
    const compiledRuntime = materializeRuntime(compiled, usdc);
    if (compiledRuntime.toLowerCase() !== liveRuntime.toLowerCase()) {
      throw new Error(`Live X402Gateway runtime mismatch at ${address}.`);
    }

    let verification = await readVerification(address);
    if (verification.is_fully_verified !== true) {
      await submitVerification(address, input);
      verification = await waitForVerification(address);
    }
    evidence.push({
      address,
      owner: getAddress(owner),
      usdc: getAddress(usdc),
      priceAtomic: price.toString(),
      runtimeCodehash: keccak256(liveRuntime),
      byteForByteExact: true,
      blockscoutFullyVerified: verification.is_fully_verified === true,
      sourceLicense: "MIT",
      explorerUrl: `${BLOCKSCOUT_URL}/address/${address}?tab=contract`,
    });
  }
  console.log(
    JSON.stringify(
      {
        status: "verified",
        chainId: BASE_CHAIN_ID,
        factory: FACTORY_ADDRESS,
        gatewayCount: evidence.length,
        gateways: evidence,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      status: "failed_closed",
      error: error instanceof Error ? error.message : "Unknown verification error.",
    }),
  );
  process.exitCode = 1;
});
