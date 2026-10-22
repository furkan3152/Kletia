// The SDK build from the Kletia origin (install without npm): the web build
// writes /sdk/kletia-sdk-<version>.js and /sdk/manifest.json, the manifest's
// integrity is the SHA-384 of exactly the written bytes, and one version
// source (packages/sdk/package.json = SDK_VERSION) is enforced.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildSdkBundle, checkSdkBundle, emitSdkScript, SDK_FILE, sdkManifest, sdkScriptPath, sdkVersion, writeSdkScript } from "../emit-sdk-script.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const realSdk = resolve(here, "../../../../packages/sdk");
const bundle = (version, literal = version) => Buffer.from(`/*! @kletia/sdk ${version} | MIT */\nconst e=${JSON.stringify(literal)};export{e as SDK_VERSION};\n`);

test("writes the versioned file and a manifest whose integrity is the SHA-384 of the written bytes", () => {
  const distDir = mkdtempSync(join(tmpdir(), "kletia-sdk-dist-"));
  try {
    const bytes = bundle("1.2.3");
    const manifest = writeSdkScript(distDir, "1.2.3", bytes);
    assert.equal(manifest.schema, "kletia.sdk-manifest/v1");
    assert.equal(manifest.version, "1.2.3");
    assert.deepEqual(JSON.parse(readFileSync(join(distDir, "sdk/manifest.json"), "utf8")), manifest);
    const served = readFileSync(join(distDir, "sdk/kletia-sdk-1.2.3.js"));
    assert.deepEqual(served, bytes);
    assert.equal(manifest.files[SDK_FILE].path, "/sdk/kletia-sdk-1.2.3.js");
    assert.equal(manifest.files[SDK_FILE].integrity, `sha384-${createHash("sha384").update(served).digest("base64")}`);
    assert.equal(manifest.files[SDK_FILE].bytes, served.byteLength);
    assert.deepEqual(sdkManifest("1.2.3", bytes), manifest);
  } finally {
    rmSync(distDir, { recursive: true, force: true });
  }
});

test("an earlier version's file stays in place (immutable paths); the manifest names the newest", () => {
  const distDir = mkdtempSync(join(tmpdir(), "kletia-sdk-dist-"));
  try {
    writeSdkScript(distDir, "1.2.3", bundle("1.2.3"));
    const manifest = writeSdkScript(distDir, "1.3.0", bundle("1.3.0"));
    assert.ok(existsSync(join(distDir, "sdk/kletia-sdk-1.2.3.js")));
    assert.equal(manifest.version, "1.3.0");
    assert.equal(sdkScriptPath("1.3.0"), "/sdk/kletia-sdk-1.3.0.js");
  } finally {
    rmSync(distDir, { recursive: true, force: true });
  }
});

test("a bundle of another version, or one whose SDK_VERSION disagrees with package.json, fails before anything is written", () => {
  const distDir = mkdtempSync(join(tmpdir(), "kletia-sdk-dist-"));
  try {
    assert.throws(() => writeSdkScript(distDir, "0.2.0", bundle("0.1.0")), /built for 0\.1\.0.*says 0\.2\.0/su);
    assert.throws(() => checkSdkBundle(bundle("0.2.0", "0.1.0"), "0.2.0"), /does not carry SDK_VERSION 0\.2\.0/u);
    assert.equal(existsSync(join(distDir, "sdk/manifest.json")), false);
  } finally {
    rmSync(distDir, { recursive: true, force: true });
  }
});

test("a package without a usable version or without a build is refused", async () => {
  const root = mkdtempSync(join(tmpdir(), "kletia-sdk-pkg-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@kletia/sdk", version: "latest" }));
    assert.throws(() => sdkVersion(root), /no usable version/u);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@kletia/sdk", version: "1.0.0" }));
    mkdirSync(join(root, "dist"));
    await assert.rejects(buildSdkBundle({ packageRoot: root, esbuild: { build: async () => assert.fail("esbuild must not run") } }), /dist\/index\.js is missing/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "the real bundle is one self-contained ESM file that imports in Node and carries packages/sdk/package.json's version",
  { skip: !existsSync(join(realSdk, "dist/index.js")) && "packages/sdk is not built" },
  async () => {
    const distDir = mkdtempSync(join(tmpdir(), "kletia-sdk-dist-"));
    try {
      const manifest = await emitSdkScript({ distDir });
      const version = sdkVersion();
      assert.equal(manifest.version, version);
      const path = join(distDir, `sdk/kletia-sdk-${version}.js`);
      const text = readFileSync(path, "utf8");
      // No bare imports left: @kletia/core is inlined, so a browser needs no import map entry for it.
      assert.doesNotMatch(text, /\bfrom\s*"@kletia\//u);
      assert.doesNotMatch(text, /\bimport\s*\(\s*"/u);
      const module = await import(pathToFileURL(path).href);
      assert.equal(module.SDK_VERSION, version);
      assert.equal(typeof module.KletiaClient, "function");
      assert.equal(typeof module.verifyWebhookSignature, "function");
    } finally {
      rmSync(distDir, { recursive: true, force: true });
    }
  },
);

test("Vercel serves the SDK file and its manifest with the headers render.yaml sets", () => {
  const vercel = JSON.parse(readFileSync(resolve(here, "../../vercel.json"), "utf8"));
  const render = readFileSync(resolve(here, "../../../../render.yaml"), "utf8");
  const headersFor = (path) => {
    const out = {};
    for (const rule of vercel.headers) {
      const source = rule.source.replace(/:file\(([^)]+)\)/u, "($1)").replace(/\(\.\*\)/u, ".*");
      if (new RegExp(`^${source}$`, "u").test(path)) for (const header of rule.headers) out[header.key] = header.value;
    }
    return out;
  };
  const file = headersFor("/sdk/kletia-sdk-0.1.0.js");
  assert.equal(file["Cache-Control"], "public, max-age=31536000, immutable");
  assert.equal(file["Access-Control-Allow-Origin"], "*");
  assert.equal(file["Cross-Origin-Resource-Policy"], "cross-origin");
  assert.match(file["Content-Type"], /^text\/javascript/u);
  const manifest = headersFor("/sdk/manifest.json");
  assert.equal(manifest["Cache-Control"], "no-cache");
  assert.equal(manifest["Access-Control-Allow-Origin"], "*");
  assert.match(render, /path: \/sdk\/kletia-sdk-\*\.js/u);
  assert.match(render, /path: \/sdk\/manifest\.json/u);
});
