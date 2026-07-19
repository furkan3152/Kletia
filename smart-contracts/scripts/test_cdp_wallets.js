const { Coinbase, Wallet } = require("@coinbase/coinbase-sdk");
require("dotenv").config({ path: "../backend/.env" });

async function main() {
  Coinbase.configure({
    apiKeyName: process.env.CDP_API_KEY_NAME,
  });

  try {
    const wallets = await Wallet.listWallets();
    console.log("Wallets found:", wallets.data.length);
    if (wallets.data.length > 0) {
      const wallet = wallets.data[0];
      console.log("Wallet ID:", wallet.getId());
      console.log("Wallet Network:", wallet.getNetworkId());
      
      const addresses = await wallet.listAddresses();
      console.log("Wallet Address:", await addresses[0].getId());
    }
  } catch (error) {
    console.error(error);
  }
}
main();
