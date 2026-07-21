const https = require('https');

https.get('https://testnet.arcscan.app/api/v2/smart-contracts/0x535EF89e3C3a74Cf1A76703972686cb7a2e34fe8', (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    const json = JSON.parse(data);
    console.log("Creation tx:", json.creation_tx_hash);
    
    https.get('https://testnet.arcscan.app/api/v2/transactions/' + json.creation_tx_hash, (res2) => {
      let data2 = '';
      res2.on('data', (chunk) => { data2 += chunk; });
      res2.on('end', () => {
        const tx = JSON.parse(data2);
        console.log("Input data:", tx.raw_input.slice(-128));
      });
    });
  });
});
