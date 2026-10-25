#!/usr/bin/env node
// Records a full, unskipped "normal user" session of the Kletia desk as a
// video, and checks every step as a test. Runs the real API and web app
// against local forks (anvil for Base, Arbitrum and Polygon; surfpool for
// Solana) with a throwaway wallet generated in memory. See
// docs/runbooks/journey-video.md.
//
//   node tooling/journey-video/run.mjs [--out DIR] [--phone] [--skip-solana]
//        [--api-url https://api.example] [--no-build] [--keep-running] [--tools-dir DIR]
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { launch } from "./lib/browser.mjs";
import { Director, clock } from "./lib/director.mjs";
import { fundEvm, fundSolana, startEvmForks, startSolanaFork } from "./lib/forks.mjs";
import { runJourney, SENTENCES } from "./lib/journey.mjs";
import { writeFindings } from "./lib/report.mjs";
import { serveStatic } from "./lib/staticServer.mjs";
import { findMarks, videoClock } from "./lib/sync.mjs";
import { createTestWallet, randomSolanaAddress } from "./lib/wallet.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const API_PORT = 3001;
const WEB_PORT = 5180;

const { values: flags } = parseArgs({
  options: {
    out: { type: "string" },
    phone: { type: "boolean", default: false },
    "skip-solana": { type: "boolean", default: false },
    "api-url": { type: "string" },
    "no-build": { type: "boolean", default: false },
    "keep-running": { type: "boolean", default: false },
    "tools-dir": { type: "string" },
    help: { type: "boolean", default: false },
  },
});
if (flags.help) {
  process.stdout.write("node tooling/journey-video/run.mjs [--out DIR] [--phone] [--skip-solana] [--api-url URL] [--no-build] [--keep-running] [--tools-dir DIR]\n");
  process.exit(0);
}

const OUT = resolve(flags.out ?? process.env.JOURNEY_OUT_DIR ?? join(tmpdir(), "kletia-journey-video"));
const TOOLS = resolve(flags["tools-dir"] ?? process.env.JOURNEY_TOOLS_DIR ?? join(OUT, "bin"));
const readOnly = Boolean(flags["api-url"]);
const cut = flags.phone ? "phone" : "desktop";
const viewport = flags.phone ? { width: 390, height: 844 } : { width: 1280, height: 800 };
mkdirSync(join(OUT, "logs"), { recursive: true });
const logs = (name) => openSync(join(OUT, "logs", name), "a");
const children = [];

function step(text) {
  process.stdout.write(`\n== ${text}\n`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: ["ignore", logs("build.log"), logs("build.log")], ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (see ${join(OUT, "logs", "build.log")}).`);
}

function portFree(port) {
  return new Promise((done) => {
    const server = createServer();
    server.once("error", () => done(false));
    server.listen(port, "127.0.0.1", () => server.close(() => done(true)));
  });
}

async function waitForHttp(url, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.status < 500 || response.status === 503) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`${url} did not answer.`);
    await new Promise((done) => setTimeout(done, 1000));
  }
}

/** The API process: built output, fork RPCs, memory stores, the outbound write guard preloaded. */
function startApi(forks, solanaRpc) {
  const env = { ...process.env };
  delete env.HTTP_PROXY;
  delete env.http_proxy;
  Object.assign(env, {
    NODE_ENV: "development",
    NODE_USE_ENV_PROXY: process.env.HTTPS_PROXY ? "1" : "",
    PORT: String(API_PORT),
    BASE_RPC_URL: forks[8453],
    ARBITRUM_RPC_URL: forks[42161],
    POLYGON_RPC_URL: forks[137],
    KLETIA_SIMULATION_RPC_URLS_BASE: forks[8453],
    KLETIA_SIMULATION_RPC_URLS_ARBITRUM: forks[42161],
    KLETIA_SIMULATION_RPC_URLS_POLYGON: forks[137],
    ...(solanaRpc ? { SOLANA_RPC_URL: solanaRpc } : {}),
    WORKFLOW_SIGNING_SECRET: randomBytes(32).toString("hex"),
    KLETIA_PLATFORM_SECRET: randomBytes(32).toString("hex"),
    KLETIA_WEB_ORIGIN: `http://127.0.0.1:${WEB_PORT}`,
    CORS_ORIGINS: `http://127.0.0.1:${WEB_PORT}`,
    KLETIA_DATABASE_URL: "",
  });
  const log = logs("api.log");
  const child = spawn(process.execPath, ["--import", join(ROOT, "tooling/journey-video/lib/netguard.mjs"), "dist/index.js"], { cwd: join(ROOT, "apps/api"), env, stdio: ["ignore", log, log] });
  children.push(child);
  return child;
}

/** The web build for this run (its own output directory; the repository's dist/ is untouched). */
function buildWeb(target, env) {
  run(process.execPath, [join(ROOT, "node_modules/vite/bin/vite.js"), "build", "--outDir", target, "--emptyOutDir"], { cwd: join(ROOT, "apps/web"), env: { ...process.env, ...env } });
}

/** Dry-runs the journey's sentences until each plans, so cold fork state is fetched before the camera rolls. */
async function warmForks(accounts) {
  const sentences = [SENTENCES.swap, SENTENCES.lend, SENTENCES.clarify, SENTENCES.clarifyAnswered, SENTENCES.bridge, "deposit 100 USDC into compound on base"];
  for (const text of sentences) {
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const response = await fetch(`http://127.0.0.1:${API_PORT}/v1/intents?clarify=true&dryRun=true`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, accounts }),
      }).catch(() => null);
      const body = response ? await response.json().catch(() => ({})) : {};
      if (body.status === "planned" || body.status === "needs_input") break;
      process.stdout.write(`  warm-up "${text}" attempt ${attempt}: ${body.error?.code ?? response?.status ?? "no answer"}\n`);
    }
  }
}

function encode(raw, director) {
  const base = join(OUT, `journey-${cut}`);
  const rawSeconds = Number(spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", raw], { encoding: "utf8" }).stdout.trim());
  const toVideo = videoClock(director.sync, findMarks(raw), director.chapters.length);
  writeFileSync(`${base}.chapters.ffmeta`, director.chaptersMetadata(rawSeconds * 1000, toVideo));
  const mp4 = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", raw, "-i", `${base}.chapters.ffmeta`, "-map_metadata", "1", "-map_chapters", "1", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart", `${base}.mp4`], { stdio: "inherit" });
  if (mp4.status !== 0) throw new Error("ffmpeg could not encode the mp4.");
  rmSync(`${base}.chapters.ffmeta`, { force: true });
  // Preview gif: the whole session at 10x, kept between 2 and 4 MB when possible.
  for (const [share, fps] of [[0.375, 5], [0.3, 4], [0.25, 3], [0.2, 3]]) {
    const scale = `scale=trunc(iw*${share}*${viewport.width < 800 ? 2 : 1}/2)*2:-2:flags=lanczos`;
    spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", `${base}.mp4`, "-vf", `setpts=PTS/10,fps=${fps},${scale},split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`, `${base}.preview.gif`], { stdio: "inherit" });
    if (existsSync(`${base}.preview.gif`) && statSync(`${base}.preview.gif`).size <= 4 * 1024 * 1024) break;
  }
  const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", `${base}.mp4`], { encoding: "utf8" });
  return { mp4: `${base}.mp4`, gif: `${base}.preview.gif`, seconds: Number(probe.stdout.trim()), toVideo };
}

async function main() {
  for (const port of readOnly ? [WEB_PORT] : [API_PORT, WEB_PORT, 8545, 8546, 8547, 8899, 8900]) {
    if (!(await portFree(port))) throw new Error(`Port ${port} is in use; stop whatever runs there first.`);
  }
  const events = [];
  let wallet;
  let forks = {};
  let solanaRpc = null;
  let apiUrl = flags["api-url"]?.replace(/\/+$/u, "");

  if (!existsSync(join(ROOT, "packages/core/dist"))) {
    step("Building the @kletia packages");
    run("npm", ["run", "build:packages"]);
  }

  if (readOnly) {
    step(`Read-only run against ${apiUrl}: no forks, the wallet signs nothing`);
    wallet = await createTestWallet({ forks: {}, solanaRpc: null, readOnly: true, onEvent: (event) => events.push(event) });
  } else {
    step("Starting the forks");
    const evm = await startEvmForks({ toolsDir: TOOLS, logs });
    children.push(...evm.children);
    forks = evm.urls;
    process.stdout.write(`  forked from ${Object.values(evm.sources).join(", ")}\n`);
    if (!flags["skip-solana"]) {
      try {
        const solana = await startSolanaFork({ toolsDir: TOOLS, logs, workDir: join(OUT, "surfpool") });
        children.push(...solana.children);
        solanaRpc = solana.url;
      } catch (error) {
        process.stdout.write(`  Solana fork unavailable (${error.message}); the Solana part is skipped.\n`);
      }
    }
    wallet = await createTestWallet({ forks, solanaRpc, onEvent: (event) => events.push(event) });
    step(`Funding the throwaway wallet ${wallet.evmAddress}${wallet.solanaAddress ? ` / ${wallet.solanaAddress}` : ""} on the forks`);
    process.stdout.write(`  ${(await fundEvm(forks, wallet.evmAddress)).join(", ")}\n`);
    if (solanaRpc) await fundSolana(solanaRpc, wallet.solanaAddress);

    if (!flags["no-build"] || !existsSync(join(ROOT, "apps/api/dist/index.js"))) {
      step("Building the API");
      run("npm", ["run", "build", "-w", "@kletia/api"]);
    }
    step("Starting the API on the forks");
    startApi(forks, solanaRpc);
    apiUrl = `http://127.0.0.1:${API_PORT}`;
    await waitForHttp(`${apiUrl}/v1/health`);
    step("Warming the forks (dry runs of the journey's sentences)");
    const accounts = [8453, 42161, 137].map((id) => `eip155:${id}:${wallet.evmAddress}`);
    if (wallet.solanaAddress) accounts.push(`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${wallet.solanaAddress}`);
    await warmForks(accounts);
  }

  const webDir = join(OUT, readOnly ? "web-dist-remote" : "web-dist-local");
  if (!flags["no-build"] || !existsSync(join(webDir, "index.html"))) {
    step("Building the web app");
    buildWeb(webDir, {
      VITE_BACKEND_URL: apiUrl,
      VITE_ALLOW_LOCAL_BACKEND: readOnly ? "false" : "true",
      VITE_ARBITRUM_MVP_ENABLED: "true",
      VITE_BASE_SWAP_EXECUTION_MODE: "intent_v2",
      VITE_ARC_VAULT_EXECUTION_MODE: "vault_v2",
      VITE_ARC_VAULT_V2_ADDRESS: "0xBe385e3520C20D44697CC1bEEDc9DF759C3A184d",
      ...(readOnly
        ? {}
        : {
            VITE_BASE_RPC_URL: forks[8453],
            VITE_ARBITRUM_RPC_URL: forks[42161],
            VITE_POLYGON_RPC_URL: forks[137],
            ...(solanaRpc ? { VITE_SOLANA_RPC_URL: solanaRpc } : {}),
          }),
    });
  }
  const web = await serveStatic(webDir, WEB_PORT);

  step(`Recording the ${cut} journey`);
  const rawDir = join(OUT, `raw-${cut}`);
  rmSync(rawDir, { recursive: true, force: true });
  const blocked = [];
  const { browser, context, page } = await launch({ wallet, viewport, videoDir: rawDir, isMobile: flags.phone, onBlocked: (entry) => blocked.push(entry) });
  const director = new Director({ page, outDir: join(OUT, `findings-${cut}`) });
  director.walletEvents = events;
  Object.assign(director, { webUrl: `http://127.0.0.1:${WEB_PORT}`, phone: flags.phone, solana: Boolean(solanaRpc), readOnly, solanaRecipient: randomSolanaAddress() });
  const consoleErrors = new Map();
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text().replace(/\s+/gu, " ").slice(0, 240);
    consoleErrors.set(text, { text, chapter: director.chapters.at(-1)?.title ?? "", count: (consoleErrors.get(text)?.count ?? 0) + 1 });
  });
  page.on("pageerror", (error) => {
    const text = `Uncaught: ${String(error.message).slice(0, 220)}`;
    consoleErrors.set(text, { text, chapter: director.chapters.at(-1)?.title ?? "", count: (consoleErrors.get(text)?.count ?? 0) + 1 });
  });

  await runJourney(director);
  await director.pause(1500);
  const video = page.video();
  await context.close();
  await browser.close();
  web.close();
  const raw = await video.path();

  step("Encoding");
  const output = encode(raw, director);
  rmSync(rawDir, { recursive: true, force: true });
  writeFileSync(join(OUT, `journey-${cut}.chapters.txt`), director.chaptersText(output.toVideo));
  const apiLog = join(OUT, "logs", "api.log");
  const findingsFile = join(OUT, cut === "desktop" ? "FINDINGS.md" : `FINDINGS-${cut}.md`);
  writeFindings(findingsFile, { director, cut, consoleErrors: [...consoleErrors.values()], blocked, apiLog: existsSync(apiLog) ? apiLog : null, video: output, readOnly, solana: Boolean(solanaRpc) });
  writeFileSync(join(OUT, `journey-${cut}.assertions.json`), JSON.stringify(director.assertions, null, 2));

  const failed = director.assertions.filter((entry) => !entry.ok);
  step("Done");
  process.stdout.write(`  video     ${output.mp4} (${clock(output.seconds * 1000)})\n  preview   ${output.gif}\n  chapters  ${join(OUT, `journey-${cut}.chapters.txt`)}\n  findings  ${findingsFile}\n  checks    ${director.assertions.length - failed.length}/${director.assertions.length} passed\n`);
  return failed.length === 0 ? 0 : 1;
}

function stopAll() {
  for (const child of children) child.kill("SIGTERM");
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopAll();
    process.exit(130);
  });
}

main().then(
  (code) => {
    if (flags["keep-running"]) {
      process.stdout.write("  --keep-running: forks and API stay up; Ctrl+C stops them.\n");
      return;
    }
    stopAll();
    process.exit(code);
  },
  (error) => {
    process.stderr.write(`\njourney-video failed: ${error.stack ?? error}\n`);
    stopAll();
    process.exit(2);
  },
);
