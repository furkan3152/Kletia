require("@nomicfoundation/hardhat-toolbox");

module.exports = {
  defaultNetwork: "hardhat",
  solidity: {

    version: "0.8.24",
    settings: {
      evmVersion: "cancun",
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    base: {

      url: process.env.BASE_RPC_URL?.trim() || "https://mainnet.base.org",
      chainId: 8453,

      accounts: []
    }
  },
  etherscan: {

    apiKey: process.env.ETHERSCAN_API_KEY || ""
  },
  sourcify: {
    enabled: true
  }
};
