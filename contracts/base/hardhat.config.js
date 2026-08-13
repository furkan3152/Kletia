require("dotenv").config();
require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-verify");

const basePrivateKey = process.env.BASE_PRIVATE_KEY?.trim();
const baseAccounts = basePrivateKey
  ? [basePrivateKey.startsWith("0x") ? basePrivateKey : `0x${basePrivateKey}`]
  : [];

module.exports = {
  defaultNetwork: "hardhat",
  solidity: {
    compilers: [
      {
        version: "0.8.24",
        settings: {
          evmVersion: "cancun",
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
      {
        version: "0.8.20",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    ],
    overrides: {
      // The live X402Factory deployment was compiled with this exact profile.
      // Keep the override pinned so local metadata and BaseScan verification
      // remain reproducible even though the rest of the package uses 0.8.24.
      "contracts/x402/X402Factory.sol": {
        version: "0.8.20",
        settings: {
          evmVersion: "paris",
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
      "contracts/x402/X402Gateway.sol": {
        version: "0.8.20",
        settings: {
          evmVersion: "paris",
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    },
  },
  networks: {
    base: {
      url: process.env.BASE_RPC_URL?.trim() || "https://mainnet.base.org",
      chainId: 8453,
      accounts: baseAccounts,
    },
  },
  etherscan: {
    apiKey: {
      base: process.env.BASESCAN_API_KEY || "",
    },
  },
  sourcify: {
    enabled: true,
  },
};
