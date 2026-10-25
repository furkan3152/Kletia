// Preloaded into the local API process (node --import) by the journey harness.
// The API runs against local forks, but it still talks to the real public
// provider APIs for quotes. This guard makes sure that nothing written by the
// journey ever reaches a real network: outbound requests to non-local hosts
// may read (GET/HEAD, JSON-RPC read methods, quote/build endpoints that only
// return unsigned data); everything else is refused before it leaves the
// process and logged as `[netguard] blocked ...` for the findings list.
import { syncBuiltinESMExports } from "node:module";
import http from "node:http";
import https from "node:https";

import { outboundVerdict } from "./guardRules.mjs";

const log = (verdict, method, url) => {
  if (verdict.allow) return;
  process.stderr.write(`[netguard] blocked ${method} ${url} (${verdict.reason})\n`);
};

const originalFetch = globalThis.fetch;
globalThis.fetch = async function guardedFetch(input, init) {
  const request = input instanceof Request ? input : null;
  const url = request ? request.url : String(input instanceof URL ? input.href : input);
  const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
  let body = init?.body ?? null;
  if (body === null && request && method !== "GET" && method !== "HEAD") body = await request.clone().text();
  const verdict = outboundVerdict({ url, method, body: typeof body === "string" ? body : body ? "[binary]" : "" });
  log(verdict, method, url);
  if (!verdict.allow) throw new TypeError(`Blocked by the journey fork guard: ${method} ${url} (${verdict.reason})`);
  return originalFetch(input, init);
};

// node:http(s).request: the body is written later, so only the method and
// host are judged here; a non-read method to a public host is refused.
for (const [module, scheme] of [[http, "http:"], [https, "https:"]]) {
  const original = module.request;
  module.request = function guardedRequest(target, options, callback) {
    const url = typeof target === "string" || target instanceof URL ? new URL(String(target)) : new URL(`${scheme}//${target.hostname ?? target.host ?? "localhost"}${target.path ?? "/"}`);
    const method = String((typeof options === "object" && options?.method) || (typeof target === "object" && !(target instanceof URL) && target.method) || "GET").toUpperCase();
    const verdict = outboundVerdict({ url: url.href, method, body: method === "GET" || method === "HEAD" ? "" : "[stream]" });
    log(verdict, method, url.href);
    if (!verdict.allow) throw new Error(`Blocked by the journey fork guard: ${method} ${url.href} (${verdict.reason})`);
    return original.apply(this, arguments);
  };
}
syncBuiltinESMExports();
process.stderr.write("[netguard] outbound write guard active\n");
