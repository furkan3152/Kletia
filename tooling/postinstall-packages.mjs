#!/usr/bin/env node
// Builds the workspace packages after `npm install` / `npm ci` so the apps can
// import their compiled entry points.
//
// A workspace-scoped install (`npm ci` inside apps/api, which is how a host
// configured with that root directory builds the API) installs only that
// workspace's dependency tree. A package whose build tools are not installed
// (the widget needs react, the embed needs esbuild) is then skipped instead of
// failing the whole install; compile errors still fail. Packages build in
// publish order, and a package is skipped when one of its @kletia
// dependencies was skipped. `npm run build:packages` always builds all five.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const order = ["core", "sdk", "widget", "embed", "cli"];

/** True when `name` is installed in a node_modules directory between `fromDir` and the repository root. */
function installed(fromDir, name) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "node_modules", name, "package.json"))) return true;
    if (dir === root || dirname(dir) === dir) return false;
  }
}

const built = new Set();
for (const name of order) {
  const directory = join(root, "packages", name);
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  const needs = { ...manifest.peerDependencies, ...manifest.dependencies, ...manifest.devDependencies };
  const missing = Object.keys(needs).filter(
    (dependency) => !installed(directory, dependency) || (dependency.startsWith("@kletia/") && !built.has(dependency)),
  );
  if (missing.length > 0) {
    console.log(`postinstall: skipped ${manifest.name} (not installed here: ${missing.join(", ")})`);
    continue;
  }
  execFileSync("npm", ["run", "build", "-w", manifest.name], { cwd: root, stdio: "inherit" });
  built.add(manifest.name);
}
