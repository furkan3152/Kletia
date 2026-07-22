const { Coinbase, Wallet } = require("@coinbase/coinbase-sdk");
require("dotenv").config({ path: "../backend/.env" });

async function main() {
  Coinbase.configure({
    apiKeyName: process.env.CDP_API_KEY_NAME,
  });
  
  try {
    // Is the secret a JSON string?
    let data;
    try {
        data = JSON.parse(process.env.CDP_WALLET_SECRET);
    } catch (e) {
        data = process.env.CDP_WALLET_SECRET;
    }
    console.log("Data type:", typeof data);
    
    // Maybe we just import it
    const wallet = await Wallet.import(data);
    console.log("Imported successfully!", wallet.getId());
  } catch (error) {
    console.error("Failed to import:", error.message || error);
  }
}
main();
