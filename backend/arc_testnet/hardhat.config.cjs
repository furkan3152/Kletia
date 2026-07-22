require("dotenv").config();
require("ts-node/register");
require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
require("@nomicfoundation/hardhat-verify");

module.exports = {
  solidity: {
    compilers: [
      { version: "0.8.24", settings: { evmVersion: "cancun" } },
      { version: "0.8.20", settings: { evmVersion: "cancun" } }
    ]
  },
  networks: {
    arc: {
      url: "https://rpc.drpc.testnet.arc.io",
      chainId: 5042002
    },
    localhost: {
      url: "http://127.0.0.1:8545"
    }
  },
  etherscan: {
    apiKey: {
      arc: "proapi_fCSCrWegirOFzoW9ETJkAuY2TFt72HMJezW7gGIwNFl0fJwz64EREQZXhoaU5eSWu_xBZdY"
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
