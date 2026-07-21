const https = require('https');

const CONTRACTS = {
  "0x535EF89e3C3a74Cf1A76703972686cb7a2e34fe8": "KletiaArcSwap",
  "0x2748a478Ec0f6D90FfdE89b27721f469126835F7": "KletiaArcLending",
  "0x09B6d2987EcAF021533A2727d2967696595Fa6dd": "KletiaArcBatchPay",
  "0xe2810DB53998f8A51bBf5Bf94c21208b174da174": "KletiaArcVault",
  "0x1633f12f31195B34feE6eDC250e1D543DAB72698": "KletiaArcMemoTransfer",
  "0xDEb07309c1689fEeCa44ac70939ce0297d511596": "KletiaArcAgentRegistry",
  "0xB85a7F6335D0544b4951e5f07Bcd326722b2BC07": "KletiaArcStaking",
  "0xf4c1F168491F22222145cff88414fE489BF8c39d": "KletiaArcOTC",
  "0xAe77D247c26258397653a020995E957Bc88E039A": "KletiaToken"
};

const API_KEY = "proapi_fCSCrWegirOFzoW9ETJkAuY2TFt72HMJezW7gGIwNFl0fJwz64EREQZXhoaU5eSWu_xBZdY";
const BASE_URL = "https://testnet.arcscan.app/api";
const ONE_DAY_AGO = Math.floor(Date.now() / 1000) - 86400;

const METHOD_MAP = {
  "0x51c6590a": "addLiquidity",
  "0x38ed1739": "swapExactTokensForTokens",
  "0x095ea7b3": "approve",
  "0xa9059cbb": "transfer",
  "0x23b872dd": "transferFrom",
  "0xe8eda9df": "deposit",
  "0x69328dec": "withdraw",
  "0x2e1a7d4d": "withdraw", // common
  "0x0": "Native Transfer (Eth)",
  "0x": "Native Transfer (Eth)"
};

async function fetchTxs(address) {
  return new Promise((resolve, reject) => {
    const url = `${BASE_URL}?module=account&action=txlist&address=${address}&apikey=${API_KEY}`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.result || []);
        } catch (e) {
          resolve([]);
        }
      });
    }).on('error', reject);
  });
}

async function main() {
  console.log("Islem detaylari taranıyor...");
  
  let actionCounts = {};
  let actionsByUser = {};

  for (const [address, name] of Object.entries(CONTRACTS)) {
    const txs = await fetchTxs(address);
    if (!Array.isArray(txs)) continue;
    
    for (const tx of txs) {
      if (parseInt(tx.timeStamp) >= ONE_DAY_AGO) {
        let methodId = tx.input.substring(0, 10);
        let methodName = tx.functionName ? tx.functionName.split('(')[0] : (METHOD_MAP[methodId] || methodId);
        
        if (tx.input === '0x') methodName = "Native Transfer (Sadece Coin Gonderimi)";

        const actionKey = `${name} -> ${methodName}`;
        
        // Count global actions
        actionCounts[actionKey] = (actionCounts[actionKey] || 0) + 1;
        
        // Count by user
        const user = tx.from.toLowerCase();
        if (!actionsByUser[user]) actionsByUser[user] = [];
        
        let status = tx.isError === "1" ? "[Basarisiz]" : "[Basarili]";
        actionsByUser[user].push(`${status} ${actionKey}`);
      }
    }
  }

  console.log(`\n--- Hangi Islemler Yapildi? (Genel Ozet) ---`);
  for (const [action, count] of Object.entries(actionCounts)) {
    console.log(`${count} defa: ${action}`);
  }

  console.log(`\n--- Kullanici Bazli Detaylar ---`);
  for (const [user, actions] of Object.entries(actionsByUser)) {
    console.log(`\nCuzdan: ${user}`);
    actions.forEach(a => console.log("  - " + a));
  }
}

main().catch(console.error);
