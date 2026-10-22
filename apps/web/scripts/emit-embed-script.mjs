// Publishes the built @kletia/embed files on the Kletia web origin (integrator
// design 4.1, P1), so the HTML snippet never depends on npm or a CDN and a
// self-hosted Kletia is self-contained:
//
//   dist/sdk/embed/<version>/kletia-embed.min.js   (classic script, SRI-pinned)
//   dist/sdk/embed/<version>/index.js              (ESM)
//   dist/sdk/embed/manifest.json                   (version, paths, SHA-384 integrity, bytes)
//
// One version source: packages/embed/package.json. The built files carry the
// version in their banner (and `EMBED_VERSION`); a stale build of another
// version fails here instead of shipping under the wrong path. The integrity
// is the SHA-384 of the exact bytes copied, so the manifest can never
// disagree with the served file.
//
// The same module serves the files in development (vite.config.ts) through
// `embedDevFile`, straight from packages/embed/dist.
//
// The same run then publishes the single-file ESM build of @kletia/sdk under
// /sdk/kletia-sdk-<version>.js with its own manifest (scripts/emit-sdk-script.mjs),
// so the web build ships both script deliveries in one step.
//
// Usage: node scripts/emit-embed-script.mjs [distDir]
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const EMBED_PACKAGE_ROOT = resolve(webRoot, "../../packages/embed");
export const EMBED_MANIFEST_SCHEMA = "kletia.embed-manifest/v1";
/** The files published per version, as named in packages/embed/dist. */
export const EMBED_FILES = Object.freeze(["kletia-embed.min.js", "index.js"]);
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

/** `sha384-<base64>`: the value of a script tag's `integrity` attribute. */
export function sriSha384(bytes) {
  return `sha384-${createHash("sha384").update(bytes).digest("base64")}`;
}

/** The embed package version (packages/embed/package.json), checked to be plain semver. */
export function embedVersion(packageRoot = EMBED_PACKAGE_ROOT) {
  const { version } = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
  if (typeof version !== "string" || !SEMVER.test(version)) throw new Error(`packages/embed/package.json has no usable version (${String(version)}).`);
  return version;
}

/** Reads one built file and checks it was built for `version` (its banner and its EMBED_VERSION literal). */
function readBuilt(packageRoot, name, version) {
  const path = resolve(packageRoot, "dist", name);
  if (!existsSync(path)) throw new Error(`packages/embed/dist/${name} is missing: build @kletia/embed first (npm run build -w @kletia/embed).`);
  const bytes = readFileSync(path);
  const text = bytes.toString("utf8");
  const banner = /^\/\*! @kletia\/embed (\S+) /u.exec(text)?.[1];
  if (banner !== version) {
    throw new Error(`packages/embed/dist/${name} was built for ${banner ?? "an unknown version"}, but packages/embed/package.json says ${version}: rebuild @kletia/embed.`);
  }
  if (!text.includes(JSON.stringify(version))) throw new Error(`packages/embed/dist/${name} does not carry EMBED_VERSION ${version}: rebuild @kletia/embed.`);
  return bytes;
}

/** The manifest for files already read: `{ schema, version, files: { name: { path, integrity, bytes } } }`. */
export function embedManifest(version, files) {
  return {
    schema: EMBED_MANIFEST_SCHEMA,
    version,
    files: Object.fromEntries(
      EMBED_FILES.map((name) => [name, { path: `/sdk/embed/${version}/${name}`, integrity: sriSha384(files[name]), bytes: files[name].byteLength }]),
    ),
  };
}

/**
 * Copies the built files to `<distDir>/sdk/embed/<version>/` and writes the
 * manifest. Earlier versions already in `distDir/sdk/embed` are left alone
 * (immutable paths); the manifest names the current one.
 */
export function emitEmbedScript({ distDir = resolve(webRoot, "dist"), packageRoot = EMBED_PACKAGE_ROOT } = {}) {
  const version = embedVersion(packageRoot);
  const files = Object.fromEntries(EMBED_FILES.map((name) => [name, readBuilt(packageRoot, name, version)]));
  const target = resolve(distDir, "sdk/embed", version);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  for (const name of EMBED_FILES) writeFileSync(resolve(target, name), files[name]);
  const manifest = embedManifest(version, files);
  writeFileSync(resolve(distDir, "sdk/embed/manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/**
 * Development server answer for a `/sdk/embed/…` path, built from
 * packages/embed/dist on every request: `{ status, body, contentType }`, or
 * null for a path outside `/sdk/embed/`.
 */
export function embedDevFile(pathname, packageRoot = EMBED_PACKAGE_ROOT) {
  if (!pathname.startsWith("/sdk/embed/")) return null;
  const notFound = { status: 404, body: Buffer.from("Not found"), contentType: "text/plain; charset=utf-8" };
  let version;
  let files;
  try {
    version = embedVersion(packageRoot);
    files = Object.fromEntries(EMBED_FILES.map((name) => [name, readBuilt(packageRoot, name, version)]));
  } catch (error) {
    return { status: 503, body: Buffer.from(error instanceof Error ? error.message : "The embed build is unavailable."), contentType: "text/plain; charset=utf-8" };
  }
  if (pathname === "/sdk/embed/manifest.json") {
    return { status: 200, body: Buffer.from(`${JSON.stringify(embedManifest(version, files), null, 2)}\n`), contentType: "application/json; charset=utf-8" };
  }
  const match = /^\/sdk\/embed\/([^/]+)\/([^/]+)$/u.exec(pathname);
  if (!match || match[1] !== version || !EMBED_FILES.includes(match[2])) return notFound;
  return { status: 200, body: files[match[2]], contentType: "text/javascript; charset=utf-8" };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const manifest = emitEmbedScript(process.argv[2] ? { distDir: resolve(process.argv[2]) } : {});
    const summary = Object.entries(manifest.files).map(([name, file]) => `${name} ${file.bytes} bytes ${file.integrity.slice(0, 19)}…`);
    console.log(`Embed script ${manifest.version} published under /sdk/embed/${manifest.version}/: ${summary.join(", ")}.`);
    const { emitSdkScript, SDK_FILE } = await import("./emit-sdk-script.mjs");
    const sdk = await emitSdkScript(process.argv[2] ? { distDir: resolve(process.argv[2]) } : {});
    const file = sdk.files[SDK_FILE];
    console.log(`SDK ${sdk.version} published at ${file.path}: ${file.bytes} bytes ${file.integrity.slice(0, 19)}…`);
  } catch (error) {
    console.error(`emit-embed-script: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
