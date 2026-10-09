import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(resolve(packageRoot, "dist/index.html"), "utf8");
const entryMatch = html.match(
  /<script[^>]+type=["']module["'][^>]+src=["']([^"']+\.js)["']/u,
);

if (!entryMatch) {
  throw new Error("Production index.html does not contain a module entry.");
}

const relativeEntry = entryMatch[1].replace(/^\//u, "");
const entryPath = resolve(packageRoot, "dist", relativeEntry);
const rawBytes = statSync(entryPath).size;
const gzipBytes = gzipSync(readFileSync(entryPath), { level: 9 }).byteLength;
// The entry holds only the router, the privacy guard and the route table: every
// page, the site shell, the art and the wallet runtimes load as lazy chunks.
const rawLimit = 200_000;
const gzipLimit = 65_000;

if (rawBytes > rawLimit || gzipBytes > gzipLimit) {
  throw new Error(
    `Entry bundle exceeds budget: ${rawBytes} raw / ${gzipBytes} gzip bytes (limit ${rawLimit} / ${gzipLimit}).`,
  );
}

console.log(
  `Entry bundle budget passed: ${rawBytes} raw / ${gzipBytes} gzip bytes.`,
);
