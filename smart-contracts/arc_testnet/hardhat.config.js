require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config({ path: "../../backend/arc_testnet/.env" }); // Load arc backend .env
require("dotenv").config(); // Load local .env

const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
const ARCSCAN_API_KEY = process.env.ARCSCAN_API_KEY || "no-key-needed";

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
    arc: {
      url: `https://testnet-rpc.arc.io`,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : []
    }
  },
  etherscan: {
    apiKey: ARCSCAN_API_KEY,
    customChains: [
      {
        network: "arc",
        chainId: 2884,
        urls: {
          apiURL: "https://testnet-explorer.arc.io/api",
          browserURL: "https://testnet-explorer.arc.io"
        }
      }
    ]
  }
};
