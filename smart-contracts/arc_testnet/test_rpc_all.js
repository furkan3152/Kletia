require("dotenv").config({ path: "../backend/.env" });
const keys = [
  process.env.CDP_API_KEY_ID,
  process.env.CDP_API_KEY_NAME.split("/").pop(), // fd16...
  process.env.CDP_API_KEY_NAME
];

async function test() {
  for (const key of keys) {
    if (!key) continue;
    const url = `https://api.developer.coinbase.com/rpc/v1/base/${key}`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 1 })
      });
      const data = await res.text();
      console.log(`URL: .../${key.substring(0, 8)}... -> Status: ${res.status} | Response: ${data.substring(0, 100)}`);
    } catch (e) {
      console.log(`URL: .../${key.substring(0, 8)}... -> ERROR: ${e.message}`);
    }
  }
}
test();
