#!/usr/bin/env node
// Verifies that each publishable @kletia package packs exactly what consumers
// need: built ESM entry points and types for every export, README and LICENSE,
// publish metadata, and no sources, tests or local configuration. Also checks
// lockstep versions (packages and the workspace apps that depend on them), the
// CLI binary and the embed loader's size budget. Run after `npm run build:packages`.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";

const root = resolve(import.meta.dirname, "..");
// Publish order: every package comes after the packages it depends on.
const packages = ["core", "sdk", "widget", "embed", "cli"];
// Subpath exports consumers rely on; removing one is a breaking change.
const requiredSubpaths = { sdk: ["./server"], widget: ["./hooks"] };
// Gzip budgets for files loaded from a CDN with Subresource Integrity.
const gzipBudgets = { embed: { "dist/index.js": 6_500, "dist/kletia-embed.min.js": 4_096 } };
const requiredBins = { cli: { kletia: "./dist/bin.js" } };
const workspaceApps = ["apps/api", "apps/web"];

const failures = [];
const fail = (message) => failures.push(message);
const normalize = (path) => path.replace(/^\.\//u, "");

/** Every file path an `exports` map points at (string leaves; patterns are skipped). */
function exportTargets(node, subpath, out) {
  if (typeof node === "string") {
    if (!node.includes("*")) out.push({ subpath, target: normalize(node) });
    return out;
  }
  if (node && typeof node === "object") {
    for (const value of Object.values(node)) exportTargets(value, subpath, out);
  }
  return out;
}

const versions = new Map();
for (const name of packages) {
  const directory = resolve(root, "packages", name);
  const manifest = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8"));
  const label = manifest.name;
  versions.set(label, manifest.version);

  if (label !== `@kletia/${name}`) fail(`packages/${name} must be named @kletia/${name}, found ${label}`);
  if (manifest.private) fail(`${label} is private`);
  if (manifest.license !== "MIT") fail(`${label} license must be MIT`);
  if (manifest.type !== "module") fail(`${label} must be an ES module package`);
  if (manifest.publishConfig?.access !== "public") fail(`${label} publishConfig.access must be public`);
  if (manifest.publishConfig?.provenance !== true) fail(`${label} must publish with provenance`);
  if (manifest.repository?.directory !== `packages/${name}`) fail(`${label} repository.directory is wrong`);
  if (manifest.exports?.["."]?.types !== "./dist/index.d.ts") fail(`${label} exports must point types at dist`);
  if (typeof manifest.scripts?.prepublishOnly !== "string") fail(`${label} needs a prepublishOnly build and test`);
  for (const [dependency, range] of Object.entries(manifest.dependencies ?? {})) {
    if (dependency.startsWith("@kletia/") && range !== manifest.version) {
      fail(`${label} depends on ${dependency}@${range}; workspace packages move in lockstep (${manifest.version})`);
    }
    if (dependency.startsWith("@kletia/") && packages.indexOf(dependency.slice(8)) > packages.indexOf(name)) {
      fail(`${label} depends on ${dependency}, which publishes after it; fix the publish order`);
    }
    if (/^(file|link|workspace):/u.test(String(range))) fail(`${label} has a local dependency ${dependency}@${range}`);
  }

  // Each conditional export needs both a type entry and an ESM entry.
  for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
    if (target && typeof target === "object" && (typeof target.types !== "string" || typeof target.import !== "string")) {
      fail(`${label} export ${subpath} must declare both "types" and "import"`);
    }
  }
  for (const subpath of requiredSubpaths[name] ?? []) {
    if (!manifest.exports?.[subpath]) fail(`${label} must export ${subpath}`);
  }
  for (const [command, target] of Object.entries(requiredBins[name] ?? {})) {
    if (normalize(String(manifest.bin?.[command] ?? "")) !== normalize(target)) fail(`${label} bin.${command} must be ${target}`);
  }

  const [report] = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: directory, encoding: "utf8" }),
  );
  const files = new Set(report.files.map((file) => file.path));
  for (const required of ["package.json", "README.md", "LICENSE", "dist/index.js", "dist/index.d.ts"]) {
    if (!files.has(required)) fail(`${label} tarball is missing ${required} (build the packages first)`);
  }

  // Everything the manifest points at must ship in the tarball.
  const referenced = [];
  const exportMap = typeof manifest.exports === "string" ? { ".": manifest.exports } : (manifest.exports ?? {});
  for (const [subpath, target] of Object.entries(exportMap)) exportTargets(target, `export ${subpath}`, referenced);
  for (const field of ["main", "module", "types", "unpkg", "jsdelivr"]) {
    if (typeof manifest[field] === "string") referenced.push({ subpath: field, target: normalize(manifest[field]) });
  }
  const bins = typeof manifest.bin === "string" ? { [name]: manifest.bin } : (manifest.bin ?? {});
  for (const [command, target] of Object.entries(bins)) {
    referenced.push({ subpath: `bin.${command}`, target: normalize(target) });
    const path = resolve(directory, target);
    if (existsSync(path) && !readFileSync(path, "utf8").startsWith("#!/usr/bin/env node\n")) {
      fail(`${label} bin.${command} (${target}) must start with "#!/usr/bin/env node"`);
    }
  }
  for (const { subpath, target } of referenced) {
    if (!files.has(target)) fail(`${label} ${subpath} points at ${target}, which is not in the tarball`);
  }

  for (const file of files) {
    if (/^(src|test|scripts)\//u.test(file) || /(^|\/)(tsconfig.*\.json|\.env.*|.*\.test\.[cm]?[jt]s)$/u.test(file)) {
      fail(`${label} tarball must not contain ${file}`);
    }
  }
  for (const [file, limit] of Object.entries(gzipBudgets[name] ?? {})) {
    if (!files.has(file)) {
      fail(`${label} tarball is missing ${file}`);
      continue;
    }
    const gzip = gzipSync(readFileSync(resolve(directory, file)), { level: 9 }).byteLength;
    if (gzip > limit) fail(`${label} ${file} is ${gzip} bytes gzipped; the budget is ${limit}`);
  }
  if (report.unpackedSize > 2_000_000) fail(`${label} unpacked size ${report.unpackedSize} exceeds 2 MB`);
  console.log(`${label}@${manifest.version}: ${files.size} files, ${report.unpackedSize} bytes unpacked`);
}

const distinct = new Set(versions.values());
if (distinct.size !== 1) {
  fail(`@kletia packages must share one version, found ${[...versions].map(([label, version]) => `${label}@${version}`).join(", ")}`);
}

// Version constants compiled into client headers and `kletia --version`
// (tooling/bump-packages.mjs keeps them in step).
const constants = [
  ["packages/sdk/src/client.ts", "SDK_VERSION", "@kletia/sdk"],
  ["packages/cli/src/cli.ts", "CLI_VERSION", "@kletia/cli"],
];
for (const [file, constant, label] of constants) {
  const match = readFileSync(resolve(root, file), "utf8").match(new RegExp(`export const ${constant}(?:: string)? = "([^"]*)"`, "u"));
  if (!match) fail(`${file} must export ${constant}`);
  else if (match[1] !== versions.get(label)) fail(`${file} ${constant} is ${match[1]} but ${label} is ${versions.get(label)}`);
}

// Workspace apps must depend on the workspace version, or npm would fetch a
// published copy instead of linking the local package.
for (const app of workspaceApps) {
  const manifest = JSON.parse(readFileSync(resolve(root, app, "package.json"), "utf8"));
  for (const field of ["dependencies", "devDependencies"]) {
    for (const [dependency, range] of Object.entries(manifest[field] ?? {})) {
      if (versions.has(dependency) && range !== versions.get(dependency)) {
        fail(`${app} ${field} ${dependency}@${range} must equal the workspace version ${versions.get(dependency)}`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error("Package verification failed:");
  for (const message of failures) console.error(`- ${message}`);
  process.exit(1);
}
console.log(`Package verification passed (${packages.length} packages at ${[...distinct][0]}).`);
