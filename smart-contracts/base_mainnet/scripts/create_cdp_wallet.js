const { Coinbase, Wallet } = require("@coinbase/coinbase-sdk");
require("dotenv").config({ path: "../backend/.env" });

async function main() {
  Coinbase.configure({
    apiKeyName: process.env.CDP_API_KEY_NAME,
  });

  try {
    console.log("Creating a new CDP Wallet...");
    const wallet = await Wallet.create({ networkId: "base-mainnet" });
    console.log("Wallet created successfully!");
    console.log("Wallet ID:", wallet.getId());

    const address = await wallet.getDefaultAddress();
    console.log("Wallet Address:", address.getId());

    const fs = require("fs");
    fs.writeFileSync("cdp_wallet.json", JSON.stringify(wallet.export()));
    console.log("Wallet saved to cdp_wallet.json");

  } catch (error) {
    console.error("Failed to create wallet:", error);
  }
}
main();
