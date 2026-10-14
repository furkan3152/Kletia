/**
 * A shop backend that keeps its Kletia key on the server:
 *
 * - `/api/kletia/*`: createKletiaProxy (browser allowlist). The page's SDK
 *   uses it as its baseUrl; keys, webhooks, contracts and rule books are
 *   refused here and never reach Kletia.
 * - `POST /api/checkout`: creates the order's intent with the key. The
 *   amount and the recipient come from the server's order book, never from
 *   the browser.
 * - `POST /webhooks/kletia`: verified webhook deliveries (expressWebhookHandler),
 *   de-duplicated by event id. `kletia listen --forward-to
 *   http://localhost:3000/webhooks/kletia` feeds it during development.
 * - `/`: a checkout page; `/vendor/*`: the SDK's browser build from node_modules.
 *
 * Run: KLETIA_API_KEY=kl_dev_… KLETIA_WEBHOOK_SECRET=whsec_… node server.mjs
 */
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, normalize, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formatAccountId, KletiaApiError, KletiaClient } from "@kletia/sdk";
import { expressKletiaProxy, expressWebhookHandler, memoryDeduplication } from "@kletia/sdk/server";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The order book. In a real shop this is your database: the browser names an
 * order, the server decides what it costs and who is paid.
 */
export const ORDERS = Object.freeze({
  "order-42": {
    label: "Acme T-shirt",
    network: "arbitrum-sepolia",
    asset: "USDC",
    amount: "25",
    // Your payout wallet (an EIP-55 test address by default; set SHOP_PAYOUT_ADDRESS).
    payTo: process.env.SHOP_PAYOUT_ADDRESS ?? "0x52908400098527886E0F7030069857D2E4169EE7",
  },
});

const MAX_JSON_BYTES = 4_096;

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) throw Object.assign(new Error("Body too large."), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("Body is not JSON."), { status: 400 });
  }
}

function sendJson(response, status, body) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}

/** Files the page may load: the SDK and core browser builds (no other path is served). */
function vendorRoots() {
  const sdk = dirname(fileURLToPath(import.meta.resolve("@kletia/sdk")));
  const core = dirname(fileURLToPath(import.meta.resolve("@kletia/core")));
  return { sdk, core };
}

async function serveVendor(pathname, response) {
  const match = /^\/vendor\/(sdk|core)\/([\w./-]+\.js)$/u.exec(pathname);
  if (!match) return false;
  const root = vendorRoots()[match[1]];
  const file = normalize(join(root, match[2]));
  if (!file.startsWith(root + sep)) return false;
  try {
    const body = await readFile(file);
    response.setHeader("content-type", "text/javascript; charset=utf-8");
    response.end(body);
    return true;
  } catch {
    return false;
  }
}

/**
 * The request handler, configurable for tests. `options.onEvent` receives
 * each verified webhook event once.
 */
export function createApp(options = {}) {
  const env = options.env ?? process.env;
  const apiKey = env.KLETIA_API_KEY;
  if (!apiKey) throw new Error("Set KLETIA_API_KEY (a developer key; a sandbox key keeps it on testnets).");
  const baseUrl = env.KLETIA_BASE_URL ?? "https://api.kletiaai.xyz";
  const kletia = new KletiaClient({ baseUrl, apiKey });
  const proxy = expressKletiaProxy({ apiKey, baseUrl, mount: "/api/kletia" });
  const processed = [];
  const webhook = env.KLETIA_WEBHOOK_SECRET
    ? expressWebhookHandler({
        secret: env.KLETIA_WEBHOOK_SECRET,
        // Kletia retries deliveries: handle each event id once.
        ...memoryDeduplication(),
        onEvent: async (event) => {
          processed.push(event.id);
          if (options.onEvent) await options.onEvent(event);
          else console.log(`webhook ${event.type} ${event.id}`);
        },
      })
    : null;

  const handler = async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    try {
      if (url.pathname.startsWith("/api/kletia/")) return await proxy(request, response);

      if (request.method === "POST" && url.pathname === "/api/checkout") {
        const body = await readJson(request);
        const order = Object.prototype.hasOwnProperty.call(ORDERS, body.orderId) ? ORDERS[body.orderId] : null;
        if (!order) return sendJson(response, 404, { error: { code: "ORDER_UNKNOWN", message: "No such order." } });
        let account;
        try {
          account = formatAccountId(order.network, String(body.address ?? ""));
        } catch {
          return sendJson(response, 400, { error: { code: "INVALID_REQUEST", message: "Send the payer's wallet address." } });
        }
        // Amount, asset, network and recipient come from the order book; anything else the browser sent is ignored.
        const { intent, preview } = await kletia.intents.create(
          {
            actions: [{ kind: "transfer", network: order.network, from: order.asset, amount: order.amount, recipient: formatAccountId(order.network, order.payTo) }],
            accounts: [account],
            clientReference: `${body.orderId}:${account.slice(-8)}`,
            metadata: { orderId: body.orderId },
          },
          { preview: true },
        );
        return sendJson(response, 201, { intentId: intent.id, title: intent.summary.title, steps: intent.steps.length, preview });
      }

      if (url.pathname === "/webhooks/kletia") {
        if (!webhook) return sendJson(response, 503, { error: { code: "WEBHOOKS_OFF", message: "Set KLETIA_WEBHOOK_SECRET." } });
        return await webhook(request, response);
      }

      if (request.method === "GET" && (await serveVendor(url.pathname, response))) return;

      if (request.method === "GET" && url.pathname === "/") {
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(await readFile(join(here, "public", "index.html")));
        return;
      }
      sendJson(response, 404, { error: { code: "NOT_FOUND", message: "Not found." } });
    } catch (error) {
      if (response.headersSent) return response.end();
      if (error instanceof KletiaApiError) return sendJson(response, error.status || 502, { error: { code: error.code, message: error.message } });
      sendJson(response, error?.status ?? 500, { error: { code: "SERVER_ERROR", message: error?.status ? error.message : "Something went wrong." } });
    }
  };
  return { handler, processed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3000);
  const { handler } = createApp();
  createServer(handler).listen(port, "127.0.0.1", () => console.log(`Shop on http://localhost:${port}`));
}
