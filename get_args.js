const https = require('https');

const contracts = {
  "Swap": "0x535EF89e3C3a74Cf1A76703972686cb7a2e34fe8",
  "Lending": "0x2748a478Ec0f6D90FfdE89b27721f469126835F7",
  "Token": "0xAe77D247c26258397653a020995E957Bc88E039A",
  "BatchPay": "0x09B6d2987EcAF021533A2727d2967696595Fa6dd",
  "Vault": "0xe2810DB53998f8A51bBf5Bf94c21208b174da174",
  "MemoTransfer": "0x1633f12f31195B34feE6eDC250e1D543DAB72698",
  "AgentRegistry": "0xDEb07309c1689fEeCa44ac70939ce0297d511596",
  "Staking": "0xB85a7F6335D0544b4951e5f07Bcd326722b2BC07",
  "OTC": "0xf4c1F168491F22222145cff88414fE489BF8c39d"
};

async function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

async function main() {
  for (const [name, addr] of Object.entries(contracts)) {
    try {
      const addrData = await fetchJson(`https://testnet.arcscan.app/api/v2/addresses/${addr}`);
      const txHash = addrData.creation_transaction_hash;
      if (!txHash) continue;
      const txData = await fetchJson(`https://testnet.arcscan.app/api/v2/transactions/${txHash}`);
      const input = txData.raw_input;
      console.log(`${name}:`);
      // Just print the last 256 chars (128 bytes) of input, it usually contains the constructor args
      console.log(input.slice(-256));
    } catch (e) {
      console.log(`${name} failed`, e.message);
    }
  }
}
main();
