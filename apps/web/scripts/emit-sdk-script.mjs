// Publishes a single-file ESM build of @kletia/sdk on the Kletia web origin,
// so integrators can use the SDK before (or without) the npm registry:
//
//   dist/sdk/kletia-sdk-<version>.js   (ESM, @kletia/core bundled in, SRI-pinned)
//   dist/sdk/manifest.json             (version, path, SHA-384 integrity, bytes)
//
// The browser loads it with an import map that carries the integrity; Node
// downloads it once, checks the hash and imports the local file (see
// docs/platform/quickstart.md). One version source: packages/sdk/package.json,
// checked against the SDK_VERSION literal in the bundle. The integrity is the
// SHA-384 of the exact bytes written, so the manifest can never disagree with
// the served file. Versioned files are immutable: earlier versions already in
// `dist/sdk` are left alone and the manifest names the current one.
//
// esbuild is resolved as a dependency of @kletia/embed (its own build tool),
// so this script needs nothing the web build does not already install.
//
// Usage: node scripts/emit-sdk-script.mjs [distDir]
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SDK_PACKAGE_ROOT = resolve(webRoot, "../../packages/sdk");
const EMBED_PACKAGE_ROOT = resolve(webRoot, "../../packages/embed");
export const SDK_MANIFEST_SCHEMA = "kletia.sdk-manifest/v1";
/** The manifest's key for the ESM build. */
export const SDK_FILE = "kletia-sdk.js";
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

/**
 * `sha384-<base64>`, the same value emit-embed-script.mjs writes. Defined
 * here, not imported: that script imports this one while it runs.
 */
export function sriSha384(bytes) {
  return `sha384-${createHash("sha384").update(bytes).digest("base64")}`;
}

/** The SDK package version (packages/sdk/package.json), checked to be plain semver. */
export function sdkVersion(packageRoot = SDK_PACKAGE_ROOT) {
  const { version } = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
  if (typeof version !== "string" || !SEMVER.test(version)) throw new Error(`packages/sdk/package.json has no usable version (${String(version)}).`);
  return version;
}

/** `/sdk/kletia-sdk-<version>.js`: where a version is served. */
export function sdkScriptPath(version) {
  return `/sdk/kletia-sdk-${version}.js`;
}

/** The manifest for built bytes: `{ schema, version, files: { "kletia-sdk.js": { path, integrity, bytes } } }`. */
export function sdkManifest(version, bytes) {
  return {
    schema: SDK_MANIFEST_SCHEMA,
    version,
    files: { [SDK_FILE]: { path: sdkScriptPath(version), integrity: sriSha384(bytes), bytes: bytes.byteLength } },
  };
}

/** Checks a bundle carries `version` as its banner and as the SDK_VERSION literal; returns the bytes. */
export function checkSdkBundle(bytes, version) {
  const text = Buffer.from(bytes).toString("utf8");
  const banner = /^\/\*! @kletia\/sdk (\S+) /u.exec(text)?.[1];
  if (banner !== version) throw new Error(`the SDK bundle was built for ${banner ?? "an unknown version"}, but packages/sdk/package.json says ${version}.`);
  if (!text.includes(JSON.stringify(version))) {
    throw new Error(`the SDK bundle does not carry SDK_VERSION ${version}: packages/sdk/src/client.ts and packages/sdk/package.json disagree (npm run bump:packages).`);
  }
  return bytes;
}

/**
 * Bundles packages/sdk/dist/index.js (the built package entry, with
 * @kletia/core inlined) into one minified ESM file for browsers and Node 18+.
 */
export async function buildSdkBundle({ packageRoot = SDK_PACKAGE_ROOT, esbuild } = {}) {
  const version = sdkVersion(packageRoot);
  const entry = resolve(packageRoot, "dist/index.js");
  if (!existsSync(entry)) throw new Error("packages/sdk/dist/index.js is missing: build @kletia/core and @kletia/sdk first (npm run build:packages).");
  const builder = esbuild ?? createRequire(resolve(EMBED_PACKAGE_ROOT, "package.json"))("esbuild");
  const result = await builder.build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    conditions: ["import", "default"],
    target: "es2022",
    minify: true,
    charset: "utf8",
    legalComments: "inline",
    banner: { js: `/*! @kletia/sdk ${version} | MIT | https://github.com/furkan3152/Kletia */` },
    write: false,
    logLevel: "warning",
  });
  const output = result.outputFiles?.[0];
  if (!output) throw new Error("esbuild returned no output for the SDK bundle.");
  return { version, bytes: checkSdkBundle(Buffer.from(output.contents), version) };
}

/** Writes `<distDir>/sdk/kletia-sdk-<version>.js` and `<distDir>/sdk/manifest.json`; returns the manifest. */
export function writeSdkScript(distDir, version, bytes) {
  checkSdkBundle(bytes, version);
  const target = resolve(distDir, "sdk");
  mkdirSync(target, { recursive: true });
  writeFileSync(resolve(distDir, `.${sdkScriptPath(version)}`), bytes);
  const manifest = sdkManifest(version, bytes);
  writeFileSync(resolve(target, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Builds the bundle and writes it under `distDir` (default apps/web/dist). */
export async function emitSdkScript({ distDir = resolve(webRoot, "dist"), packageRoot = SDK_PACKAGE_ROOT, esbuild } = {}) {
  const { version, bytes } = await buildSdkBundle({ packageRoot, esbuild });
  return writeSdkScript(distDir, version, bytes);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const manifest = await emitSdkScript(process.argv[2] ? { distDir: resolve(process.argv[2]) } : {});
    const file = manifest.files[SDK_FILE];
    console.log(`SDK ${manifest.version} published at ${file.path}: ${file.bytes} bytes ${file.integrity.slice(0, 19)}…`);
  } catch (error) {
    console.error(`emit-sdk-script: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
