#!/usr/bin/env node
/**
 * Runs every example under `examples/` the way a developer would, against
 * the packages in this checkout instead of the npm registry:
 *
 * 1. packs the workspace packages (`npm pack`; build them first with
 *    `npm run build:packages`) into a temporary directory;
 * 2. copies each example there and points its `@kletia/*` dependencies at the
 *    tarballs (registry dependencies such as React and Vite install as usual,
 *    from the npm cache when it has them);
 * 3. `node --check` on every JavaScript file, then the example's `build`
 *    script when it has one (`vite build`);
 * 4. a per-example smoke run against an in-process stub of `/v1` on
 *    127.0.0.1: nothing reaches the network, no key is used, nothing is
 *    signed.
 *
 * Usage: node tooling/check-examples.mjs [--keep] [--if-enabled] [example…]
 *   --keep        keep the temporary directory (its path is printed)
 *   --if-enabled  do nothing unless KLETIA_CHECK_EXAMPLES=1 (how `verify` calls it)
 * Exits 1 when any example fails.
 */
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const keep = args.includes("--keep");
if (args.includes("--if-enabled") && process.env.KLETIA_CHECK_EXAMPLES !== "1") {
  console.log("check-examples: skipped (set KLETIA_CHECK_EXAMPLES=1 to run it in verify).");
  process.exit(0);
}
const only = args.filter((arg) => !arg.startsWith("--"));
const PACKAGES = ["core", "sdk", "widget", "embed"];

const failures = [];
const fail = (example, message) => {
  failures.push(`${example}: ${message}`);
  console.error(`  FAIL ${message}`);
};

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { encoding: "utf8", stdio: "pipe", ...options, env: { ...process.env, ...options.env } });
  return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

/** Like `run`, without blocking this process: the in-process stub must keep answering while the child runs. */
function runAsync(command, commandArgs, options = {}) {
  return new Promise((done) => {
    const child = spawn(command, commandArgs, { ...options, env: { ...process.env, ...options.env }, stdio: "pipe" });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      done({ ok: status === 0, output: output.trim() });
    });
  });
}

const tail = (text, lines = 25) => text.split("\n").slice(-lines).join("\n");

// ---------------------------------------------------------------------------
// The /v1 stub: canned answers, every request recorded for the assertions.
// ---------------------------------------------------------------------------

const PREVIEW_EVM = "eip155:8453:0x9B58BE768EAB41bD43C8293DDDB6bf3c0D066590";

function stubIntent(request) {
  const text = String(request.text ?? "");
  // "…to ethereum" plans a bridge that lands on Ethereum: outside a base/solana scope.
  const destination = /ethereum/iu.test(text) ? "ethereum" : "solana";
  return {
    id: `int_${"0".repeat(32)}`,
    status: "planned",
    request,
    summary: { title: text || "Stub plan", signaturesRequired: 1 },
    steps: [
      {
        id: "step_1",
        index: 0,
        kind: "bridge",
        title: `Bridge 25 USDC from Base to ${destination === "ethereum" ? "Ethereum" : "Solana"}`,
        network: "base",
        chain: "eip155:8453",
        account: PREVIEW_EVM,
        protocol: "relay",
        mode: "wallet",
        dependsOn: [],
        status: "ready",
        evidence: [],
        settlement: { destinationNetwork: destination },
      },
    ],
  };
}

function startStub() {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 65_536) req.destroy();
    });
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://stub");
      let parsed = null;
      try {
        parsed = body ? JSON.parse(body) : null;
      } catch {
        parsed = null;
      }
      requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body: parsed });
      const send = (status, payload) => {
        res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
        res.end(JSON.stringify(payload));
      };
      if (req.method === "GET" && url.pathname === "/v1/health") return send(200, { status: "ok" });
      if (req.method === "POST" && url.pathname === "/v1/intents" && parsed) {
        const intent = stubIntent(parsed);
        return send(url.searchParams.get("dryRun") === "true" ? 200 : 201, url.searchParams.get("preview") === "true" ? { intent, preview: null } : { intent });
      }
      return send(404, { error: { code: "NOT_FOUND", message: "The stub does not serve this route." } });
    });
  });
  return new Promise((resolveStub) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolveStub({ url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((done) => server.close(done)) });
    });
  });
}

// ---------------------------------------------------------------------------
// Per-example smoke runs (executed inside the installed copy).
// ---------------------------------------------------------------------------

/**
 * react-vite: renders <App /> on the server with the installed widget (Vite
 * SSR), then plans through the installed SDK with the example's own
 * settings against the stub and checks the widget's scope on the result.
 */
const REACT_VITE_SMOKE = String.raw`
import assert from "node:assert/strict";
import { createServer } from "vite";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import { KletiaClient } from "@kletia/sdk";
import { PREVIEW_ACCOUNT_IDS } from "@kletia/core";
import { outOfScope } from "@kletia/widget";

const stub = process.env.KLETIA_STUB_URL;
const quiet = console.error;
console.error = (...items) => { if (!String(items[0]).includes("useLayoutEffect")) quiet(...items); };
const vite = await createServer({ root: process.cwd(), logLevel: "error", appType: "custom", server: { middlewareMode: true, hmr: false } });
try {
  const { App } = await vite.ssrLoadModule("/src/App.jsx");
  const config = await vite.ssrLoadModule("/src/config.js");
  const html = renderToString(createElement(App));
  assert.match(html, /class="kw-root"/u, "the widget renders");
  assert.match(html, /--kw-accent:#6D28D9/u, "appearance tokens reach the root");
  assert.match(html, /data-shadow="soft"/u, "the shadow token is applied");
  assert.match(html, />Preview</u, "plan-only lane label without a wallet");
  assert.match(html, /Non-custodial · your wallet signs every step/u, "the footer is always shown");

  const client = new KletiaClient({ baseUrl: stub, maxRetries: 0 });
  const request = { text: "bridge 25 USDC from base to solana", accounts: [...PREVIEW_ACCOUNT_IDS], sourceNetwork: "auto" };
  const planned = await client.intents.create(request, { preview: true });
  assert.equal(outOfScope(planned.intent, { networks: config.NETWORKS, actions: config.ACTIONS }), null, "an in-scope plan passes");
  const other = await client.intents.create({ ...request, text: "bridge 25 USDC from base to ethereum" }, { preview: true });
  const refusal = outOfScope(other.intent, { networks: config.NETWORKS, actions: config.ACTIONS });
  assert.deepEqual(refusal?.networks, ["ethereum"], "a bridge to an excluded network is refused");
  console.log("react-vite smoke: ok");
} finally {
  await vite.close();
}
`;

const SMOKES = {
  "react-vite": {
    script: REACT_VITE_SMOKE,
    check(requests) {
      const plans = requests.filter((request) => request.method === "POST" && request.path === "/v1/intents");
      if (plans.length !== 2) return `expected 2 plans at the stub, saw ${plans.length}`;
      if (plans.some((request) => request.headers.authorization)) return "a plan carried an Authorization header (the browser must stay on the public tier)";
      if (plans.some((request) => request.body?.sourceNetwork !== "auto")) return "sourceNetwork auto was not sent";
      return null;
    },
  },
};

// ---------------------------------------------------------------------------

function jsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...jsFiles(path));
    else if (/\.(?:m?js|cjs)$/u.test(entry)) out.push(path);
  }
  return out;
}

const examplesDir = join(root, "examples");
const examples = readdirSync(examplesDir)
  .filter((name) => existsSync(join(examplesDir, name, "package.json")))
  .filter((name) => only.length === 0 || only.includes(name));
if (examples.length === 0) {
  console.error("check-examples: no examples found.");
  process.exit(1);
}

for (const name of PACKAGES) {
  if (!existsSync(join(root, "packages", name, "dist", "index.js"))) {
    console.error(`check-examples: packages/${name}/dist is missing; run npm run build:packages first.`);
    process.exit(1);
  }
}

const work = mkdtempSync(join(tmpdir(), "kletia-examples-"));
const tarballDir = join(work, "tarballs");
mkdirSync(tarballDir);
console.log(`check-examples: packing ${PACKAGES.map((name) => `@kletia/${name}`).join(", ")}`);
const packed = run("npm", ["pack", "--json", "--pack-destination", tarballDir, ...PACKAGES.flatMap((name) => ["-w", `@kletia/${name}`])], { cwd: root });
if (!packed.ok) {
  console.error(tail(packed.output));
  process.exit(1);
}
const tarballs = Object.fromEntries(
  JSON.parse(packed.output.slice(packed.output.indexOf("["))).map((entry) => [entry.name, join(tarballDir, entry.filename.replace(/^@kletia\//u, "kletia-").replace(/\//gu, "-"))]),
);
for (const [pkg, path] of Object.entries(tarballs)) {
  if (!existsSync(path)) {
    const found = readdirSync(tarballDir).find((file) => file.startsWith(pkg.replace("@", "").replace("/", "-")));
    if (found) tarballs[pkg] = join(tarballDir, found);
    else {
      console.error(`check-examples: the tarball of ${pkg} is missing.`);
      process.exit(1);
    }
  }
}

const stub = await startStub();
try {
  for (const example of examples) {
    console.log(`\n${example}`);
    const target = join(work, example);
    cpSync(join(examplesDir, example), target, { recursive: true, filter: (source) => !/[/\\](?:node_modules|dist)$/u.test(source) });
    const manifestPath = join(target, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const overrides = {};
    for (const field of ["dependencies", "devDependencies"]) {
      for (const pkg of Object.keys(manifest[field] ?? {})) {
        if (!tarballs[pkg]) continue;
        manifest[field][pkg] = `file:${relative(target, tarballs[pkg])}`;
        overrides[pkg] = `$${pkg}`;
      }
    }
    // The packages depend on each other by version: the overrides keep every copy on the tarballs.
    for (const pkg of Object.keys(tarballs)) overrides[pkg] ??= `file:${relative(target, tarballs[pkg])}`;
    manifest.overrides = { ...(manifest.overrides ?? {}), ...overrides };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const install = run("npm", ["install", "--no-audit", "--no-fund", "--prefer-offline", "--loglevel=error"], { cwd: target });
    if (!install.ok) {
      fail(example, `npm install failed\n${tail(install.output)}`);
      continue;
    }
    console.log("  ok   install");

    let syntaxOk = true;
    for (const file of jsFiles(target)) {
      const check = run(process.execPath, ["--check", file]);
      if (!check.ok) {
        syntaxOk = false;
        fail(example, `node --check ${relative(target, file)}\n${tail(check.output)}`);
      }
    }
    if (syntaxOk) console.log("  ok   node --check");

    if (manifest.scripts?.build) {
      const built = run("npm", ["run", "build", "--silent"], { cwd: target });
      if (!built.ok) fail(example, `npm run build failed\n${tail(built.output)}`);
      else console.log("  ok   build");
    }

    const smoke = SMOKES[example];
    if (smoke) {
      stub.requests.length = 0;
      writeFileSync(join(target, "kletia-smoke.mjs"), smoke.script);
      const ran = await runAsync(process.execPath, ["kletia-smoke.mjs"], { cwd: target, env: { KLETIA_STUB_URL: stub.url } });
      const problem = ran.ok ? smoke.check(stub.requests) : `smoke run failed\n${tail(ran.output)}`;
      if (problem) fail(example, problem);
      else console.log("  ok   smoke against the /v1 stub");
    }
  }
} finally {
  await stub.close();
  if (keep) console.log(`\ncheck-examples: kept ${work}`);
  else rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\ncheck-examples: ${failures.length} failure(s)`);
  process.exit(1);
}
console.log(`\ncheck-examples: ${examples.length} example(s) passed`);
