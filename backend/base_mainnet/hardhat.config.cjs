require("dotenv").config();
require("ts-node/register");
require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
require("@nomicfoundation/hardhat-verify");
const path = require("node:path");
const { subtask } = require("hardhat/config");
const {
  TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS
} = require("hardhat/builtin-tasks/task-names");

// Contract tooling in this package is intentionally Arc-only. The unified
// runtime supports Base Mainnet, but no Base deploy target is exposed here;
// adding one requires a separate deployment review and explicit credentials.
// ArcScan credentials must be supplied at runtime.
const ARCSCAN_API_KEY = process.env.ARCSCAN_API_KEY?.trim();
const ARC_TESTNET_RPC_URL =
  process.env.ARC_RPC_URL?.trim() ||
  "https://rpc.testnet.arc.network";
const requiresArcScanApiKey = process.argv.some(
  (argument) => argument === "verify" || argument.startsWith("verify:")
);

if (requiresArcScanApiKey && !ARCSCAN_API_KEY) {
  throw new Error("ARCSCAN_API_KEY is required for ArcScan contract verification.");
}

const CONTRACTS_ROOT = path.resolve(__dirname, "contracts");
const ARC_SOURCES_ROOT = path.join(CONTRACTS_ROOT, "arc");
const ARC_SHARED_SOURCES = new Set([
  path.join(CONTRACTS_ROOT, "KletiaToken.sol")
]);

// Enforce the Arc-only contract boundary at Hardhat's source-discovery layer.
// Root Base-era contracts cannot silently enter Arc compile/test artifacts.
subtask(
  TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS
).setAction(async (_taskArgs, _hre, runSuper) => {
  const sourcePaths = await runSuper();
  const selectedSources = sourcePaths.filter((sourcePath) => {
    const absoluteSource = path.resolve(sourcePath);
    return (
      absoluteSource.startsWith(`${ARC_SOURCES_ROOT}${path.sep}`) ||
      ARC_SHARED_SOURCES.has(absoluteSource)
    );
  });
  if (
    selectedSources.length === 0 ||
    !selectedSources.some((sourcePath) =>
      ARC_SHARED_SOURCES.has(path.resolve(sourcePath))
    )
  ) {
    throw new Error("ARC_SOURCE_SET_INCOMPLETE");
  }
  return selectedSources;
});

module.exports = {
  defaultNetwork: "hardhat",
  solidity: {
    compilers: [
      { version: "0.8.24", settings: { evmVersion: "cancun" } },
      { version: "0.8.20", settings: { evmVersion: "cancun" } }
    ]
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache/arc-only",
    artifacts: "./artifacts/arc-only"
  },
  networks: {
    hardhat: {
      chainId: 31337
    },
    arc: {
      url: ARC_TESTNET_RPC_URL,
      chainId: 5042002,
      accounts: []
    },
    localhost: {
      url: "http://127.0.0.1:8545"
    }
  },
  etherscan: {
    apiKey: {
      arc: ARCSCAN_API_KEY || ""
    },
    customChains: [
      {
        network: "arc",
        chainId: 5042002,
        urls: {
          apiURL: "https://testnet.arcscan.app/api",
          browserURL: "https://testnet.arcscan.app"
        }
      }
    ]
  }
};
