#!/usr/bin/env node
// Builds @kletia/embed from its single source file:
// - dist/index.js            ESM for bundlers and <script type="module">
// - dist/kletia-embed.min.js minified IIFE for a plain <script> tag (global `KletiaEmbed`
//   with EMBED_VERSION, buildEmbedUrl, defineKletiaIntent and mountKletiaIntent)
// Type declarations come from `tsc` (see the `build` script). Fails when a
// file exceeds its gzip budget, so the SRI-pinned loader stays small.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const banner = `/*! @kletia/embed ${version} | MIT | https://github.com/furkan3152/Kletia */`;
const shared = {
  entryPoints: [resolve(root, "src/index.ts")],
  target: "es2022",
  platform: "browser",
  charset: "utf8",
  legalComments: "inline",
  banner: { js: banner },
  define: { __KLETIA_EMBED_VERSION__: JSON.stringify(version) },
  logLevel: "warning",
};

// Readable ESM (whitespace and names kept) so the published file is easy to audit.
await build({ ...shared, outfile: resolve(root, "dist/index.js"), format: "esm", bundle: false, minifySyntax: true });
// The script-tag global exposes the runtime API only; tree shaking drops the rest.
await build({
  ...shared,
  entryPoints: undefined,
  stdin: {
    contents: 'export { EMBED_VERSION, buildEmbedUrl, defineKletiaIntent, mountKletiaIntent } from "./src/index.ts";',
    resolveDir: root,
    sourcefile: "kletia-embed.ts",
    loader: "ts",
  },
  outfile: resolve(root, "dist/kletia-embed.min.js"),
  format: "iife",
  globalName: "KletiaEmbed",
  bundle: true,
  minify: true,
});

const budgets = { "dist/index.js": 6_500, "dist/kletia-embed.min.js": 4_096 };
let failed = false;
for (const [file, limit] of Object.entries(budgets)) {
  const bytes = readFileSync(resolve(root, file));
  const gzip = gzipSync(bytes, { level: 9 }).byteLength;
  const ok = gzip <= limit;
  failed ||= !ok;
  console.log(`${file}: ${bytes.byteLength} bytes, ${gzip} gzip (budget ${limit})${ok ? "" : " OVER BUDGET"}`);
}
if (failed) process.exit(1);
