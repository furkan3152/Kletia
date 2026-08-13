const fs = require("node:fs");
const path = require("node:path");
const solc = require("solc");
const { JsonRpcProvider, keccak256 } = require("ethers");

const FACTORY_ADDRESS = "0xD6e7bAc04a9969f75AEA3f17b5b82db1C988DD46";
const BASE_CHAIN_ID = 8_453;
const COMPILER_VERSION = "v0.8.20+commit.a1b79de6";
const CONTRACT_NAME = "contracts/X402Factory.sol:X402Factory";
const projectRoot = path.resolve(__dirname, "../..");

function source(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

function factoryVerificationSource() {
  let content = source("contracts/x402/X402Factory.sol");
  const exactWhitespace = [
    [
      "X402Gateway[] public allGateways;\n\n    // Mapping",
      "X402Gateway[] public allGateways;\n    \n    // Mapping",
    ],
    [
      'require(_usdc != address(0), "Invalid token address");\n\n        // Deploy',
      'require(_usdc != address(0), "Invalid token address");\n        \n        // Deploy',
    ],
    [
      "X402Gateway(_usdc, _initialPrice, msg.sender);\n\n        // Store",
      "X402Gateway(_usdc, _initialPrice, msg.sender);\n        \n        // Store",
    ],
    [
      "getGatewaysByOwner[msg.sender].push(newGateway);\n\n        emit",
      "getGatewaysByOwner[msg.sender].push(newGateway);\n        \n        emit",
    ],
    [
      "emit GatewayCreated(address(newGateway), msg.sender, _usdc, _initialPrice);\n\n        return",
      "emit GatewayCreated(address(newGateway), msg.sender, _usdc, _initialPrice);\n        \n        return",
    ],
    [
      "return address(newGateway);\n    }\n\n    /**",
      "return address(newGateway);\n    }\n    \n    /**",
    ],
  ];
  for (const [normalized, deployed] of exactWhitespace) {
    if (!content.includes(normalized)) {
      throw new Error("X402Factory source no longer matches the reproducible whitespace map.");
    }
    content = content.replace(normalized, deployed);
  }
  return content;
}

function standardInput() {
  return {
    language: "Solidity",
    sources: {
      "contracts/X402Factory.sol": {
        content: factoryVerificationSource(),
      },
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
          "*": ["*"],
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
  const errors = (output.errors || []).filter(
    (entry) => entry.severity === "error",
  );
  if (errors.length > 0) {
    throw new Error(errors.map((entry) => entry.formattedMessage).join("\n"));
  }
  const object =
    output.contracts["contracts/X402Factory.sol"].X402Factory.evm
      .deployedBytecode.object;
  if (!object) throw new Error("X402Factory runtime bytecode was empty.");
  return `0x${object}`;
}

async function exactRuntimeEvidence(input) {
  const compiledRuntime = compile(input);
  const provider = new JsonRpcProvider(
    process.env.BASE_RPC_URL?.trim() || "https://base-rpc.publicnode.com",
    BASE_CHAIN_ID,
    { staticNetwork: true },
  );
  const [network, liveRuntime, blockNumber] = await Promise.all([
    provider.getNetwork(),
    provider.getCode(FACTORY_ADDRESS),
    provider.getBlockNumber(),
  ]);
  if (network.chainId !== BigInt(BASE_CHAIN_ID)) {
    throw new Error(`Wrong Base chain: ${network.chainId}.`);
  }
  if (liveRuntime === "0x") throw new Error("X402Factory has no runtime code.");
  if (compiledRuntime.toLowerCase() !== liveRuntime.toLowerCase()) {
    throw new Error(
      `Runtime mismatch: compiled ${keccak256(compiledRuntime)}, live ${keccak256(liveRuntime)}.`,
    );
  }
  return {
    chainId: BASE_CHAIN_ID,
    observedAtBlock: blockNumber,
    address: FACTORY_ADDRESS,
    compilerVersion: COMPILER_VERSION,
    optimizerEnabled: true,
    optimizerRuns: 200,
    evmVersion: "paris",
    runtimeCodehash: keccak256(liveRuntime),
    byteForByteExact: true,
  };
}

async function baseScanPageEvidence() {
  const response = await fetch(
    `https://basescan.org/address/${FACTORY_ADDRESS}?output=1`,
    {
      headers: { accept: "text/html" },
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!response.ok) {
    throw new Error(`BaseScan contract page HTTP ${response.status}.`);
  }
  const html = await response.text();
  const exactMatch = /<strong>Exact Match<\/strong>/u.test(html);
  const similarMatch = html.match(/Similar Match:[\s\S]{0,600}?href=['"]\/address\/(0x[0-9a-fA-F]{40})#code/u);
  if (!exactMatch) {
    throw new Error("BaseScan does not currently display the Exact Match badge.");
  }
  return {
    verification: "exact_match",
    sourceAttribution: similarMatch
      ? "byte_identical_similar_match_source"
      : "self_attributed_source",
    similarMatchSource: similarMatch?.[1] || null,
    explorerUrl: `https://basescan.org/address/${FACTORY_ADDRESS}#code`,
  };
}

async function submitVerification(input) {
  const apiKey = process.env.BASESCAN_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "BASESCAN_API_KEY is required only for --submit; local and live exact-bytecode checks already passed.",
    );
  }
  const body = new URLSearchParams({
    apikey: apiKey,
    chainid: String(BASE_CHAIN_ID),
    module: "contract",
    action: "verifysourcecode",
    contractaddress: FACTORY_ADDRESS,
    sourceCode: JSON.stringify(input),
    codeformat: "solidity-standard-json-input",
    contractname: CONTRACT_NAME,
    compilerversion: COMPILER_VERSION,
    constructorArguments: "",
    optimizationUsed: "1",
    runs: "200",
    evmVersion: "paris",
    licenseType: "3",
  });
  const response = await fetch("https://api.etherscan.io/v2/api", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`Etherscan verification HTTP ${response.status}.`);
  }
  const result = await response.json();
  if (
    result.status !== "1" &&
    !String(result.result || "").toLowerCase().includes("already verified")
  ) {
    throw new Error(`Verification submission rejected: ${result.result}.`);
  }
  return {
    guid: result.status === "1" ? result.result : null,
    alreadyVerified: result.status !== "1",
  };
}

async function waitForVerification(apiKey, guid) {
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const body = new URLSearchParams({
      apikey: apiKey,
      chainid: String(BASE_CHAIN_ID),
      module: "contract",
      action: "checkverifystatus",
      guid,
    });
    const response = await fetch("https://api.etherscan.io/v2/api", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new Error(`Verification status HTTP ${response.status}.`);
    }
    const result = await response.json();
    if (result.status === "1" && result.result === "Pass - Verified") {
      return;
    }
    const message = String(result.result || "");
    if (!message.toLowerCase().includes("pending in queue")) {
      throw new Error(`Verification failed: ${message}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error("Verification remained pending beyond 60 seconds.");
}

async function assertPublishedCompilerProfile(apiKey) {
  const query = new URLSearchParams({
    apikey: apiKey,
    chainid: String(BASE_CHAIN_ID),
    module: "contract",
    action: "getsourcecode",
    address: FACTORY_ADDRESS,
  });
  const response = await fetch(`https://api.etherscan.io/v2/api?${query}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`Published source lookup HTTP ${response.status}.`);
  }
  const body = await response.json();
  const published = Array.isArray(body.result) ? body.result[0] : null;
  if (
    !published ||
    published.ContractName !== "X402Factory" ||
    published.CompilerVersion !== COMPILER_VERSION ||
    published.OptimizationUsed !== "1" ||
    published.Runs !== "200" ||
    String(published.EVMVersion || "").toLowerCase() !== "paris"
  ) {
    throw new Error("Published BaseScan compiler profile does not match the proven local input.");
  }
  return {
    contractName: published.ContractName,
    contractFileName: published.ContractFileName || null,
    compilerVersion: published.CompilerVersion,
    optimizationUsed: published.OptimizationUsed,
    runs: published.Runs,
    evmVersion: published.EVMVersion,
    similarMatch: published.SimilarMatch || null,
  };
}

async function main() {
  const input = standardInput();
  const evidence = await exactRuntimeEvidence(input);
  evidence.baseScan = await baseScanPageEvidence();
  if (process.argv.includes("--write-standard-input")) {
    const outputPath = path.join(
      projectRoot,
      ".local",
      "x402-factory-standard-input.json",
    );
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(input, null, 2)}\n`, {
      mode: 0o600,
    });
    evidence.standardInputPath = outputPath;
  }
  if (process.argv.includes("--submit")) {
    const apiKey = process.env.BASESCAN_API_KEY.trim();
    const submission = await submitVerification(input);
    if (submission.guid) {
      await waitForVerification(apiKey, submission.guid);
    }
    evidence.verificationGuid = submission.guid;
    evidence.publishedProfile = await assertPublishedCompilerProfile(apiKey);
    evidence.status = "verified_and_published";
  } else {
    evidence.status = "live_runtime_and_basescan_exact_match";
  }
  console.log(JSON.stringify(evidence, null, 2));
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
