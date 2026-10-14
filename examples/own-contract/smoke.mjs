/**
 * Smoke check of this example against an in-process stub of Kletia's /v1 on
 * 127.0.0.1: no network, no real key, nothing signed. `npm run check` (and
 * the repository's `npm run check:examples`, through `npm run build`) runs it.
 *
 * - register.mjs runs inspect → validate → register → test with the testnet
 *   definition (rebasing output) and refuses an invalid one before registering.
 * - session-server.mjs creates one session per page view for the
 *   registration and embeds it.
 * - flow.mjs stores the registration as a project flow (If-Match), allows
 *   the page origin and issues a publishable key for the snippet.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { KletiaClient } from "@kletia/sdk";
import { registerAndTest } from "./register.mjs";
import { createSessionApp } from "./session-server.mjs";
import { publishFlow } from "./flow.mjs";

const KEY = "kl_dev_smoke_0123456789abcdefghijkl";
const CT = "ct_5f1c2a9b7e3d4c6a8b0e1f23";
const WALLET = "0x52908400098527886E0F7030069857D2E4169EE7";

function listen(handler) {
  const server = createServer(handler);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

const seen = [];
const stub = await listen((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const url = new URL(req.url, "http://stub");
    const route = `${req.method} ${url.pathname}`;
    seen.push({ route, query: Object.fromEntries(url.searchParams), headers: req.headers, body: body ? JSON.parse(body) : null });
    const send = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (route === "GET /v1/contracts/inspect") {
      return send(200, { inspection: { vm: "evm", network: url.searchParams.get("network"), address: url.searchParams.get("address"), deployed: true, eip7702: false, denied: null, pins: { codeHash: `0x${"1".repeat(64)}`, proxy: null }, functions: [] } });
    }
    if (route === "POST /v1/contracts") return send(201, { contract: { id: CT, status: "active", activatesAt: null } });
    if (route === `POST /v1/contracts/${CT}/test`) {
      return send(200, { test: { contract: CT, revision: 1, entry: "supply", transactions: [{ description: "Approve" }, { description: "Supply" }], review: { simulation: { status: "ok" }, notices: ["Not audited by Kletia."] }, warnings: [] } });
    }
    if (route === "POST /v1/sessions") return send(201, { session: { id: `cs_${"a".repeat(32)}`, status: "active", warnings: [] } });
    const project = (version, settings) => ({ id: "prj_key_smoke", version, hash: `sha256:${String(version).repeat(64).slice(0, 64)}`, settings, domain: { host: null, verified: false, checkedAt: null, file: "{}" }, logo: null, updatedAt: "2026-10-14T00:00:00.000Z", updatedBy: "key_smoke" });
    if (route === "GET /v1/projects/current") return send(200, { project: project(1, { schema: "kletia.project/v1", allowedOrigins: ["https://old.example"] }) });
    if (route === "PATCH /v1/projects/current") {
      const flows = (JSON.parse(body).flows ?? []).map((flow) => ({ ...flow, ownerKeyId: "key_smoke" }));
      return send(200, { project: project(2, { schema: "kletia.project/v1", ...JSON.parse(body), flows }) });
    }
    if (route === "POST /v1/projects/current/publishable-keys") {
      return send(201, { key: { id: "key_pub", key: `kl_pub_${"A".repeat(32)}`, label: "website", kind: "publishable", parentId: "key_smoke", createdAt: "2026-10-14T00:00:00.000Z" } });
    }
    return send(404, { error: { code: "NOT_FOUND", message: "The stub does not serve this route." } });
  });
});

try {
  const kletia = new KletiaClient({ baseUrl: stub.url, apiKey: KEY, maxRetries: 0 });
  const definition = JSON.parse(await readFile(new URL("./contract.arbitrum-sepolia.json", import.meta.url), "utf8"));
  assert.equal(definition.actions[0].output.rebasing, true, "the aToken output is rebasing");
  const lines = [];
  const { contract, test } = await registerAndTest(kletia, definition, WALLET, (line) => lines.push(line));
  assert.equal(contract.id, CT);
  assert.equal(test.review.simulation.status, "ok");
  assert.deepEqual(seen.map((entry) => entry.route), ["GET /v1/contracts/inspect", "POST /v1/contracts", `POST /v1/contracts/${CT}/test`]);
  assert.equal(seen[1].body.actions[0].output.rebasing, true);
  assert.ok(seen[1].headers["idempotency-key"], "registering carries an Idempotency-Key");
  assert.deepEqual(seen[2].body, { entry: "supply", account: `eip155:421614:${WALLET}`, amount: "1" });
  assert.ok(lines.some((line) => line.includes("notice: Not audited by Kletia.")));

  // An invalid definition is refused locally, after the inspection and before anything is stored.
  seen.length = 0;
  await assert.rejects(registerAndTest(kletia, { ...definition, actions: [] }, WALLET, () => {}), /invalid/u);
  assert.ok(!seen.some((entry) => entry.route === "POST /v1/contracts"));

  // The base vault definition validates too.
  const vault = JSON.parse(await readFile(new URL("./contract.base.json", import.meta.url), "utf8"));
  assert.equal(vault.actions[0].function, "deposit(uint256,address)");

  // One session per page view.
  seen.length = 0;
  const page = await listen(createSessionApp({ env: { KLETIA_API_KEY: KEY, KLETIA_BASE_URL: stub.url, CONTRACT_ID: CT, PAGE_ORIGIN: "http://localhost:3001" } }));
  try {
    const html = await (await fetch(page.url)).text();
    assert.match(html, /session="cs_a{32}"/u);
    assert.doesNotMatch(html, /kl_dev_/u, "the key never reaches the page");
    await fetch(page.url);
    const sessions = seen.filter((entry) => entry.route === "POST /v1/sessions");
    assert.equal(sessions.length, 2, "a new session for each view");
    assert.deepEqual(sessions[0].body.actions, [{ kind: "call", network: "arbitrum-sepolia", contract: CT, entry: "supply", amount: "10" }]);
    assert.deepEqual(sessions[0].body.allowedOrigins, ["http://localhost:3001"]);
  } finally {
    page.server.close();
  }
  // The phase-2 path: the registration as a project flow, run in the browser with a publishable key.
  seen.length = 0;
  const flowLines = [];
  const published = await publishFlow(kletia, { contractId: CT, pageOrigin: "https://shop.example" }, (line) => flowLines.push(line));
  assert.deepEqual(seen.map((entry) => entry.route), ["GET /v1/projects/current", "PATCH /v1/projects/current", "POST /v1/projects/current/publishable-keys"]);
  assert.equal(seen[1].headers["if-match"], `"sha256:${"1".repeat(64)}"`, "the change is based on the hash read first");
  assert.deepEqual(seen[1].body.allowedOrigins, ["https://old.example", "https://shop.example"]);
  assert.deepEqual(seen[1].body.flows[0].actions, [{ kind: "call", network: "arbitrum-sepolia", contract: CT, entry: "supply", amount: "10" }]);
  assert.equal(published.snippet, `<kletia-intent key="kl_pub_${"A".repeat(32)}" flow="supply"></kletia-intent>`);
  assert.ok(flowLines.some((line) => line.includes("saved by key_smoke")));
  console.log("own-contract smoke: ok");
} finally {
  stub.server.close();
}
