const { Coinbase, Wallet } = require("@coinbase/coinbase-sdk");
require("dotenv").config({ path: "../backend/.env" });

async function main() {
  Coinbase.configure({
    apiKeyName: process.env.CDP_API_KEY_ID,
    privateKey: process.env.CDP_API_KEY_SECRET,
  });
  
  try {
    const wallets = await Wallet.listWallets();
    console.log("Success:", wallets.data.length);
  } catch(e) {
    console.error(e.message || e);
  }
}
main();
