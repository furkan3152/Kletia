#!/usr/bin/env node
// Moves every publishable @kletia package to one new version, in lockstep:
//
//   npm run bump:packages -- 0.2.0            # write the changes and sync the lockfile
//   npm run bump:packages -- 0.2.0 --dry-run  # list what would change
//
// It updates each package's version and its @kletia/* dependency ranges, the
// workspace apps' @kletia/* dependencies, the version constants compiled into
// the SDK and CLI, the embed version the developer portal pins, and the
// @kletia/embed CDN URLs in the documentation. Then it runs
// `npm install --package-lock-only` so package-lock.json matches.
// Release afterwards with a `packages-v<version>` tag (see release-packages.yml)
// and recompute the Subresource Integrity hashes from the published files.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const rootFlag = args.indexOf("--root");
const root = rootFlag >= 0 ? resolve(args[rootFlag + 1] ?? ".") : resolve(import.meta.dirname, "..");
const version = args.find((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--root");

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/u;
if (!version || !SEMVER.test(version)) {
  console.error("Usage: node tooling/bump-packages.mjs <version> [--dry-run]   (for example 0.2.0 or 0.3.0-rc.1)");
  process.exit(2);
}

const packages = ["core", "sdk", "widget", "embed", "cli"];
const packageNames = new Set(packages.map((name) => `@kletia/${name}`));
const changed = [];

function rewrite(file, transform) {
  const path = resolve(root, file);
  if (!existsSync(path)) return;
  const before = readFileSync(path, "utf8");
  const after = transform(before);
  if (after === before) return;
  changed.push(file);
  if (!dryRun) writeFileSync(path, after);
}

function bumpManifest(file, { own }) {
  rewrite(file, (source) => {
    const manifest = JSON.parse(source);
    if (own) manifest.version = version;
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      for (const dependency of Object.keys(manifest[field] ?? {})) {
        if (packageNames.has(dependency)) manifest[field][dependency] = version;
      }
    }
    return `${JSON.stringify(manifest, null, 2)}\n`;
  });
}

for (const name of packages) bumpManifest(`packages/${name}/package.json`, { own: true });
for (const app of ["apps/api", "apps/web"]) bumpManifest(`${app}/package.json`, { own: false });

// Version constants sent as client headers and printed by `kletia --version`.
const constants = [
  ["packages/sdk/src/client.ts", "SDK_VERSION"],
  ["packages/cli/src/cli.ts", "CLI_VERSION"],
  ["apps/web/src/app/site/snippets.ts", "EMBED_VERSION"],
];
for (const [file, constant] of constants) {
  rewrite(file, (source) =>
    source.replace(new RegExp(`(export const ${constant}(?:: string)? = ")[^"]*(")`, "u"), `$1${version}$2`),
  );
}

// Pinned CDN URLs in documentation (the SRI hash next to them changes too).
for (const file of ["README.md", "docs/platform/embed.md", "packages/embed/README.md"]) {
  rewrite(file, (source) =>
    source.replace(/@kletia\/embed@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?=\/)/gu, `@kletia/embed@${version}`),
  );
}

if (changed.length === 0) {
  console.log(`Everything is already at ${version}.`);
  process.exit(0);
}
console.log(`${dryRun ? "Would update" : "Updated"} ${changed.length} files to ${version}:`);
for (const file of changed) console.log(`- ${file}`);

if (!dryRun) {
  execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: root,
    stdio: "inherit",
  });
  console.log("Synced package-lock.json.");
  console.log(
    `Next: npm run build:packages && npm run check:packages, commit, then push the tag packages-v${version}. ` +
      "After publishing, replace the integrity=\"sha384-…\" values with hashes of the published files.",
  );
}
