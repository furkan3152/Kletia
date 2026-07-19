const { Coinbase, Wallet } = require("@coinbase/coinbase-sdk");
require("dotenv").config({ path: "../backend/.env" });

async function main() {
  Coinbase.configure({
    apiKeyName: process.env.CDP_API_KEY_NAME,
  });
  console.log("Using CDP Node URL:", Coinbase.useServerSigner); // just probing
  
  // Try to create a Wallet or deploy contract?
}
main();
