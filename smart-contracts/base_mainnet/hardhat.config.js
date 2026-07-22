require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config({ path: "../../backend/base_mainnet/.env" }); // Load base backend .env
require("dotenv").config(); // Load local .env

const CDP_NODE_API_KEY = process.env.CDP_NODE_API_KEY || "";
const BASESCAN_API_KEY = process.env.BASESCAN_API_KEY || "";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";

module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    base: {
      url: `https://api.developer.coinbase.com/rpc/v1/base/${CDP_NODE_API_KEY}`,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : []
    }
  },
  etherscan: {
    apiKey: BASESCAN_API_KEY,
    customChains: [
      {
        network: "base",
        chainId: 8453,
        urls: {
          apiURL: "https://api.basescan.org/api",
          browserURL: "https://basescan.org"
        }
      }
    ]
  }
};
