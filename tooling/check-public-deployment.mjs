#!/usr/bin/env node
// Read-only smoke check of a public Kletia deployment (API and web origins).
//
//   node tooling/check-public-deployment.mjs <api origin> <web origin> [--timeout <ms>] [--skip <probe>]... [--json]
//   node tooling/check-public-deployment.mjs https://api.kletiaai.xyz https://kletiaai.xyz
//
// Probes (GET only; nothing is created, signed or sent):
//   api-health     GET <api>/v1/health: 200, api "v1", status ok or degraded, build.commit present
//   api-openapi    GET <api>/v1/openapi.json: 200, an OpenAPI 3.1 document
//   web-developers GET <web>/developers: 200 HTML
//   web-embed      GET <web>/embed: 200 with Content-Security-Policy frame-ancestors *
//   embed-script   GET <web>/sdk/embed/manifest.json, then every file it lists: the served
//                  bytes hash to the manifest's sha384 integrity
//
// Prints one line per probe and exits 1 when any probe fails (2 on usage
// errors). `--skip <probe>` leaves a probe out (for example embed-script on a
// deployment that predates the script delivery). The first request to a cold
// free-tier instance can take about 50 s, so the default timeout is 60 s.
// .github/workflows/public-smoke.yml runs this hourly; `npm run verify` never
// does (its tests serve local stubs).
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export const PROBES = Object.freeze(["api-health", "api-openapi", "web-developers", "web-embed", "embed-script"]);
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const COMMIT = /^[0-9a-f]{7,64}$/u;
const INTEGRITY = /^sha384-[A-Za-z0-9+/]{64}$/u;

/** A bare http(s) origin, or null. */
export function parseOrigin(raw) {
  try {
    const url = new URL(String(raw));
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Fetches one URL (GET, bounded by the timeout and the body cap); never throws. */
async function get(url, timeoutMs, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetchImpl(url, { method: "GET", redirect: "follow", signal: controller.signal, headers: { accept: "*/*", "user-agent": "kletia-public-smoke/1" } });
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_BODY_BYTES) return { ok: false, error: `body larger than ${MAX_BODY_BYTES} bytes`, ms: Date.now() - started };
    return { ok: true, status: response.status, headers: response.headers, body: buffer, ms: Date.now() - started };
  } catch (error) {
    const reason = controller.signal.aborted ? `timed out after ${timeoutMs} ms` : error instanceof Error ? error.message : String(error);
    return { ok: false, error: reason, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

function json(body) {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return undefined;
  }
}

/** The first line of a non-JSON body, for messages such as "Cannot GET /v1/health". */
function excerpt(body) {
  const text = body.toString("utf8").replace(/<[^>]*>/gu, " ").replace(/\s+/gu, " ").trim();
  return text.slice(0, 80);
}

function statusFailure(reply, expected = 200) {
  if (!reply.ok) return reply.error;
  if (reply.status !== expected) {
    const text = excerpt(reply.body);
    return `HTTP ${reply.status}${text ? ` (${text})` : ""}`;
  }
  return null;
}

async function probeApiHealth(api, timeoutMs, fetchImpl) {
  const reply = await get(`${api}/v1/health`, timeoutMs, fetchImpl);
  const failure = statusFailure(reply);
  if (failure) return { ok: false, detail: failure, ms: reply.ms };
  const body = json(reply.body);
  if (!body || body.api !== "v1") return { ok: false, detail: "not a Platform API v1 health report", ms: reply.ms };
  if (body.status !== "ok" && body.status !== "degraded") return { ok: false, detail: `status ${String(body.status)}`, ms: reply.ms };
  const commit = body.build?.commit;
  if (typeof commit !== "string" || !COMMIT.test(commit)) return { ok: false, detail: `status ${body.status}, but build.commit is missing (deployment identity unknown)`, ms: reply.ms };
  return { ok: true, detail: `status ${body.status}, commit ${commit.slice(0, 12)} (${body.build.source ?? "unknown source"})`, ms: reply.ms };
}

async function probeApiOpenApi(api, timeoutMs, fetchImpl) {
  const reply = await get(`${api}/v1/openapi.json`, timeoutMs, fetchImpl);
  const failure = statusFailure(reply);
  if (failure) return { ok: false, detail: failure, ms: reply.ms };
  const body = json(reply.body);
  if (!body || typeof body.openapi !== "string" || !body.openapi.startsWith("3.1") || typeof body.paths !== "object") {
    return { ok: false, detail: "not an OpenAPI 3.1 document", ms: reply.ms };
  }
  return { ok: true, detail: `OpenAPI ${body.openapi}, ${Object.keys(body.paths).length} paths`, ms: reply.ms };
}

async function probeDevelopers(web, timeoutMs, fetchImpl) {
  const reply = await get(`${web}/developers`, timeoutMs, fetchImpl);
  const failure = statusFailure(reply);
  if (failure) return { ok: false, detail: failure, ms: reply.ms };
  if (!/text\/html/iu.test(reply.headers.get("content-type") ?? "")) return { ok: false, detail: "not served as HTML", ms: reply.ms };
  return { ok: true, detail: "HTML", ms: reply.ms };
}

async function probeEmbed(web, timeoutMs, fetchImpl) {
  const reply = await get(`${web}/embed`, timeoutMs, fetchImpl);
  const failure = statusFailure(reply);
  if (failure) return { ok: false, detail: failure, ms: reply.ms };
  const policy = reply.headers.get("content-security-policy") ?? "";
  const ancestors = policy
    .split(";")
    .map((part) => part.trim())
    .find((part) => /^frame-ancestors\s/iu.test(part));
  if (!ancestors || ancestors.split(/\s+/u)[1] !== "*") return { ok: false, detail: `frame-ancestors is ${ancestors ? `"${ancestors}"` : "missing"}, expected *`, ms: reply.ms };
  return { ok: true, detail: "frame-ancestors *", ms: reply.ms };
}

async function probeEmbedScript(web, timeoutMs, fetchImpl) {
  const reply = await get(`${web}/sdk/embed/manifest.json`, timeoutMs, fetchImpl);
  const failure = statusFailure(reply);
  if (failure) return { ok: false, detail: `manifest: ${failure}`, ms: reply.ms };
  const manifest = json(reply.body);
  if (!manifest || manifest.schema !== "kletia.embed-manifest/v1" || typeof manifest.files !== "object" || manifest.files === null) {
    return { ok: false, detail: "manifest is not kletia.embed-manifest/v1", ms: reply.ms };
  }
  const entries = Object.entries(manifest.files);
  if (entries.length === 0) return { ok: false, detail: "manifest lists no files", ms: reply.ms };
  let ms = reply.ms;
  for (const [name, file] of entries) {
    const path = file?.path;
    if (typeof path !== "string" || !path.startsWith("/sdk/embed/") || path.includes("..") || !INTEGRITY.test(file?.integrity ?? "")) {
      return { ok: false, detail: `manifest entry ${name} is malformed`, ms };
    }
    const script = await get(`${web}${path}`, timeoutMs, fetchImpl);
    ms += script.ms;
    const scriptFailure = statusFailure(script);
    if (scriptFailure) return { ok: false, detail: `${path}: ${scriptFailure}`, ms };
    const integrity = `sha384-${createHash("sha384").update(script.body).digest("base64")}`;
    if (integrity !== file.integrity) return { ok: false, detail: `${path}: served bytes do not match the manifest integrity`, ms };
  }
  return { ok: true, detail: `version ${String(manifest.version)}, ${entries.length} file(s) match their integrity`, ms };
}

const RUNNERS = {
  "api-health": (origins, timeoutMs, fetchImpl) => probeApiHealth(origins.api, timeoutMs, fetchImpl),
  "api-openapi": (origins, timeoutMs, fetchImpl) => probeApiOpenApi(origins.api, timeoutMs, fetchImpl),
  "web-developers": (origins, timeoutMs, fetchImpl) => probeDevelopers(origins.web, timeoutMs, fetchImpl),
  "web-embed": (origins, timeoutMs, fetchImpl) => probeEmbed(origins.web, timeoutMs, fetchImpl),
  "embed-script": (origins, timeoutMs, fetchImpl) => probeEmbedScript(origins.web, timeoutMs, fetchImpl),
};

/**
 * Runs the probes in order (the API health first, so a cold instance wakes
 * before the rest) and returns `{ ok, results }`.
 */
export async function checkPublicDeployment({ api, web, timeoutMs = DEFAULT_TIMEOUT_MS, skip = [], fetchImpl = globalThis.fetch }) {
  const results = [];
  for (const name of PROBES) {
    if (skip.includes(name)) {
      results.push({ probe: name, ok: true, skipped: true, detail: "skipped", ms: 0 });
      continue;
    }
    const result = await RUNNERS[name]({ api, web }, timeoutMs, fetchImpl);
    results.push({ probe: name, ...result });
  }
  return { ok: results.every((result) => result.ok), results };
}

function usage(message) {
  if (message) console.error(message);
  console.error("Usage: node tooling/check-public-deployment.mjs <api origin> <web origin> [--timeout <ms>] [--skip <probe>]... [--json]");
  console.error(`Probes: ${PROBES.join(", ")}`);
  return 2;
}

export async function main(argv) {
  const positional = [];
  const skip = [];
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let asJson = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") asJson = true;
    else if (arg === "--timeout") {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < 100 || value > 300_000) return usage("--timeout takes milliseconds between 100 and 300000.");
      timeoutMs = value;
    } else if (arg === "--skip") {
      const value = argv[++index];
      if (!PROBES.includes(value)) return usage(`--skip takes one of: ${PROBES.join(", ")}.`);
      skip.push(value);
    } else if (arg.startsWith("--")) return usage(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  if (positional.length !== 2) return usage();
  const api = parseOrigin(positional[0]);
  const web = parseOrigin(positional[1]);
  if (!api || !web) return usage("Both arguments must be bare http(s) origins, such as https://api.kletiaai.xyz.");
  const report = await checkPublicDeployment({ api, web, timeoutMs, skip });
  if (asJson) console.log(JSON.stringify({ api, web, ...report }, null, 2));
  else {
    console.log(`Kletia public deployment: api ${api}, web ${web}`);
    for (const result of report.results) {
      const mark = result.skipped ? "SKIP" : result.ok ? "PASS" : "FAIL";
      console.log(`${mark}  ${result.probe.padEnd(15)} ${String(result.ms).padStart(6)} ms  ${result.detail}`);
    }
    console.log(report.ok ? "All probes passed." : `${report.results.filter((result) => !result.ok).length} probe(s) failed.`);
  }
  return report.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv.slice(2));
}
