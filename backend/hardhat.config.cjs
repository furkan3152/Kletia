require("dotenv").config();
require("ts-node/register");
require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");

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
  }
};
