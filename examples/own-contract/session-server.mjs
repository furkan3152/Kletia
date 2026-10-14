/**
 * One session per page view: the server creates a short-lived session for
 * your registered contract (fixed template, your allowed origin, a bounded
 * amount) and the page embeds it. The visitor's wallet signs; the key stays
 * here.
 *
 *   CONTRACT_ID=ct_… KLETIA_API_KEY=kl_dev_… node session-server.mjs   # http://localhost:3001
 */
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { KletiaClient } from "@kletia/sdk";

const here = dirname(fileURLToPath(import.meta.url));

const escapeHtml = (value) => String(value).replace(/[&<>"']/gu, (char) => `&#${char.charCodeAt(0)};`);

/** The handler, configurable for the smoke check. */
export function createSessionApp(options = {}) {
  const env = options.env ?? process.env;
  if (!env.KLETIA_API_KEY || !env.CONTRACT_ID) throw new Error("Set KLETIA_API_KEY and CONTRACT_ID (from register.mjs).");
  const kletia = new KletiaClient({ apiKey: env.KLETIA_API_KEY, ...(env.KLETIA_BASE_URL ? { baseUrl: env.KLETIA_BASE_URL } : {}) });
  const origin = env.PAGE_ORIGIN ?? `http://localhost:${env.PORT ?? 3001}`;
  const webOrigin = env.KLETIA_WEB_ORIGIN ?? "https://kletiaai.xyz";
  const embedScript = env.KLETIA_EMBED_SCRIPT ?? `${webOrigin}/sdk/embed/${env.KLETIA_EMBED_VERSION ?? "0.1.0"}/kletia-embed.min.js`;
  const network = env.CONTRACT_NETWORK ?? "arbitrum-sepolia";
  const entry = env.CONTRACT_ENTRY ?? "supply";

  return async (request, response) => {
    if (request.method !== "GET" || new URL(request.url ?? "/", "http://localhost").pathname !== "/") {
      response.statusCode = 404;
      return response.end("Not found");
    }
    try {
      // A fresh session per page view: single use, 15 minutes, this page's origin only.
      const session = await kletia.sessions.create({
        actions: [{ kind: "call", network, contract: env.CONTRACT_ID, entry, amount: "10" }],
        amount: { action: 0, min: "1", max: "100", default: "10" },
        allowedOrigins: [origin],
        expiresInSeconds: 900,
        clientReference: `page-${Date.now()}`,
      });
      for (const warning of session.warnings ?? []) console.warn(`session ${session.id}: ${warning.code} ${warning.contract} activates at ${warning.activatesAt}`);
      const page = (await readFile(join(here, "page.html"), "utf8"))
        .replaceAll("{{EMBED_SCRIPT}}", escapeHtml(embedScript))
        .replaceAll("{{KLETIA_WEB_ORIGIN}}", escapeHtml(webOrigin))
        .replaceAll("{{SESSION_ID}}", escapeHtml(session.id));
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.setHeader("cache-control", "no-store");
      response.end(page);
    } catch (error) {
      response.statusCode = 502;
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.end(`Could not start a session: ${error.code ?? ""} ${error.message}`);
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3001);
  createServer(createSessionApp()).listen(port, "127.0.0.1", () => console.log(`Page on http://localhost:${port}`));
}
