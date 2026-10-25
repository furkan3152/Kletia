// Outbound request rules of the journey harness, shared by the API preload
// (netguard.mjs) and the browser route guard (browser.mjs). Reads are free;
// writes may only reach the local forks. A public host gets a non-read
// request only when it is a JSON-RPC read or a quote/build call that returns
// unsigned data; order submissions, API-key creation, relays and every
// broadcast method are refused.

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** JSON-RPC methods that write, sign or change node state. */
const WRITE_RPC = /^(eth_send|eth_sign|personal_sign|sendTransaction|sendRawTransaction|requestAirdrop|anvil_|hardhat_|evm_|wallet_|surfnet_)/u;

/** Paths that submit something signed or create an account-bound credential. */
const SUBMIT_PATH = /(\/orders?(\/|$)|\/auth\/api-key|\/submit|\/execute|\/relay|\/send|\/cancel|\/sign)/iu;

/** Quote and unsigned-build endpoints of the public provider APIs (Hyperliquid's /info is its read API). */
const READ_PATH = /(^\/info$|quote|price|swap-instructions|\/swap\/v1\/swap$|route\/build|-instructions|ktx\/klend|assemble|\/routes?$|\/simulate|\/estimate)/iu;

export function isLocalUrl(url) {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

function rpcMethods(body) {
  if (!body || body === "[binary]" || body === "[stream]") return null;
  try {
    const parsed = JSON.parse(body);
    const calls = Array.isArray(parsed) ? parsed : [parsed];
    if (!calls.length || !calls.every((call) => call && typeof call.method === "string" && "jsonrpc" in call)) return null;
    return calls.map((call) => call.method);
  } catch {
    return null;
  }
}

/** `{ allow, reason }` for one outbound request. */
export function outboundVerdict({ url, method, body }) {
  if (isLocalUrl(url)) return { allow: true, reason: "local" };
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return { allow: true, reason: "read" };
  let path = "";
  try {
    path = new URL(url).pathname;
  } catch {
    return { allow: false, reason: "unparsable url" };
  }
  const methods = rpcMethods(body);
  if (methods) {
    const write = methods.find((name) => WRITE_RPC.test(name));
    return write ? { allow: false, reason: `json-rpc write ${write} to a public node` } : { allow: true, reason: "json-rpc read" };
  }
  if (SUBMIT_PATH.test(path)) return { allow: false, reason: "submission to a public service" };
  if (READ_PATH.test(path)) return { allow: true, reason: "quote/build" };
  return { allow: false, reason: "non-read request to a public host" };
}
