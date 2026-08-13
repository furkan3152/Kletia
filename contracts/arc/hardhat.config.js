require("dotenv").config();
require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-verify");

const arcRpcUrl =
  process.env.ARC_RPC_URL?.trim() || "https://rpc.testnet.arc.network";
const arcPrivateKey = process.env.ARC_PRIVATE_KEY?.trim();
const arcAccounts = arcPrivateKey
  ? [arcPrivateKey.startsWith("0x") ? arcPrivateKey : `0x${arcPrivateKey}`]
  : [];

module.exports = {
  defaultNetwork: "hardhat",
  solidity: {
    compilers: [
      {
        version: "0.8.24",
        settings: {
          evmVersion: "cancun",
          // Matches the existing Arc Testnet deployment metadata exactly.
          optimizer: { enabled: false },
        },
      },
      {
        version: "0.8.20",
        settings: {
          evmVersion: "cancun",
          optimizer: { enabled: false },
        },
      },
    ],
  },
  networks: {
    arc: {
      url: arcRpcUrl,
      chainId: 5042002,
      accounts: arcAccounts,
    },
  },
  etherscan: {
    apiKey: {
      arc: process.env.ARCSCAN_API_KEY?.trim() || "",
    },
    customChains: [
      {
        network: "arc",
        chainId: 5042002,
        urls: {
          apiURL: "https://testnet.arcscan.app/api",
          browserURL: "https://testnet.arcscan.app",
        },
      },
    ],
  },
};
