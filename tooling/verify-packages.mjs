#!/usr/bin/env node
// Verifies that each publishable @kletia package packs exactly what consumers
// need: built ESM entry points and types, README and LICENSE, publish metadata,
// and no sources, tests or local configuration. Run after `npm run build:packages`.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packages = ["core", "sdk", "widget", "cli"];
const failures = [];
const fail = (message) => failures.push(message);

const versions = new Set();
for (const name of packages) {
  const directory = resolve(root, "packages", name);
  const manifest = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8"));
  const label = manifest.name;
  versions.add(manifest.version);

  if (manifest.private) fail(`${label} is private`);
  if (manifest.license !== "MIT") fail(`${label} license must be MIT`);
  if (manifest.type !== "module") fail(`${label} must be an ES module package`);
  if (manifest.publishConfig?.access !== "public") fail(`${label} publishConfig.access must be public`);
  if (manifest.publishConfig?.provenance !== true) fail(`${label} must publish with provenance`);
  if (manifest.repository?.directory !== `packages/${name}`) fail(`${label} repository.directory is wrong`);
  if (manifest.exports?.["."]?.types !== "./dist/index.d.ts") fail(`${label} exports must point types at dist`);
  for (const [dependency, range] of Object.entries(manifest.dependencies ?? {})) {
    if (dependency.startsWith("@kletia/") && range !== manifest.version) {
      fail(`${label} depends on ${dependency}@${range}; workspace packages move in lockstep (${manifest.version})`);
    }
    if (/^(file|link|workspace):/u.test(String(range))) fail(`${label} has a local dependency ${dependency}@${range}`);
  }

  const [report] = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: directory, encoding: "utf8" }),
  );
  const files = new Set(report.files.map((file) => file.path));
  for (const required of ["package.json", "README.md", "LICENSE", "dist/index.js", "dist/index.d.ts"]) {
    if (!files.has(required)) fail(`${label} tarball is missing ${required} (build the packages first)`);
  }
  for (const file of files) {
    if (/^(src|test)\//u.test(file) || /(^|\/)(tsconfig.*\.json|\.env.*|.*\.test\.[cm]?[jt]s)$/u.test(file)) {
      fail(`${label} tarball must not contain ${file}`);
    }
  }
  if (report.unpackedSize > 2_000_000) fail(`${label} unpacked size ${report.unpackedSize} exceeds 2 MB`);
  console.log(`${label}@${manifest.version}: ${files.size} files, ${report.unpackedSize} bytes unpacked`);
}

if (versions.size !== 1) fail(`@kletia packages must share one version, found ${[...versions].join(", ")}`);

if (failures.length > 0) {
  console.error("Package verification failed:");
  for (const message of failures) console.error(`- ${message}`);
  process.exit(1);
}
console.log("Package verification passed.");
