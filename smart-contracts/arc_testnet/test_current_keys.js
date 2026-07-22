const { Coinbase, Wallet } = require("@coinbase/coinbase-sdk");
require("dotenv").config({ path: "../backend/.env" });

async function main() {
  Coinbase.configure({
    apiKeyName: process.env.CDP_API_KEY_NAME,
  });
  
  try {
    console.log("Creating wallet...");
    const wallet = await Wallet.create({ networkId: "base-mainnet" });
    console.log("Success! Wallet ID:", wallet.getId());
    console.log("Address:", await wallet.getDefaultAddress());
  } catch(e) {
    console.error("Error:", e.message || e);
  }
}
main();
