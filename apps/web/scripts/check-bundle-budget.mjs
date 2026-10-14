// Bundle budgets, run by `npm run build` after the route pages:
//
// 1. The entry script: at most 200,000 raw / 65,000 gzip bytes. It holds only the router, the privacy guard and the
//    route table; every page, the site shell, the art and the wallet runtimes load as lazy chunks.
// 2. The entry stylesheet: at most 27 KiB gzip (25.2 KiB after the motion system moved out of it).
//    The target is 24 KiB: what remains is Tailwind's utilities for every route, the desk's and the
//    portal's included, which leave the entry only when tailwind.config.js splits its content per surface.
// 3. The developer portal's shell chunk (the `developers` route page): at most 15 KiB gzip.
// 4. The /embed page's initial closure (its chunk and every chunk it imports statically, beyond the entry) carries
//    no wallet runtime: the wallet kit loads only when the visitor presses Connect (EmbedWalletBar).
//
// Usage: node scripts/check-bundle-budget.mjs [distDirectory]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

export const BUDGETS = Object.freeze({
  entryRaw: 200_000,
  entryGzip: 65_000,
  entryCssGzip: 27 * 1024,
  portalShellGzip: 15 * 1024,
});

/**
 * Markers of wallet runtimes in built chunks. wagmi is matched by its runtime's own version stamps, not the bare
 * word: a page may read wagmi's storage key ("wagmi.recentConnectorId") to decide whether to prefetch the wallet
 * bar without loading wagmi.
 */
export const WALLET_MARKERS = Object.freeze({
  wagmi: /@wagmi\/core@|\bwagmi@\d|WagmiProvider/u,
  rainbowkit: /rainbowkit|data-rk/iu,
  viem: /viem@|Version: viem/u,
  solanaKit: /@solana\/kit|getTransactionDecoder|SolanaError/u,
  walletconnect: /walletconnect/iu,
  walletStandard: /wallet-standard:register-wallet|wallet-standard:app-ready/u,
});

const gzipSize = (buffer) => gzipSync(buffer, { level: 9 }).byteLength;

/** The entry script and stylesheet named by dist/index.html (asset paths relative to dist). */
export function entryAssets(html) {
  const script = html.match(/<script[^>]+type=["']module["'][^>]+src=["']\/?([^"']+\.js)["']/u)?.[1] ?? null;
  const styles = [...html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]+href=["']\/?(assets\/[^"']+\.css)["']/gu)].map((match) => match[1]);
  return { script, styles };
}

/** Relative chunk files a built chunk imports statically (`import ... from "./x.js"`, `import "./x.js"`, `export ... from`). */
export function staticImports(code) {
  const found = new Set();
  for (const match of code.matchAll(/(?:import|export)\s*(?:[\w${},*\s]+?\s*from\s*)?["']\.\/([^"']+\.js)["']/gu)) found.add(match[1]);
  return [...found];
}

/** Every chunk reachable from `start` through static imports. `read` returns a chunk's code. */
export function staticClosure(start, read) {
  const seen = new Set();
  const stack = [start];
  while (stack.length > 0) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const next of staticImports(read(file))) stack.push(next);
  }
  return seen;
}

/** Wallet markers found in a set of chunks, as "marker in file" lines. */
export function walletMarkersIn(files, read) {
  const hits = [];
  for (const file of files) {
    const code = read(file);
    for (const [name, pattern] of Object.entries(WALLET_MARKERS)) if (pattern.test(code)) hits.push(`${name} in ${file}`);
  }
  return hits;
}

/** Checks a built dist directory; returns the problems (empty when every budget holds) and the measured sizes. */
export function checkBudgets(dist, budgets = BUDGETS) {
  const problems = [];
  const sizes = {};
  const html = readFileSync(resolve(dist, "index.html"), "utf8");
  const { script, styles } = entryAssets(html);
  if (!script) return { problems: ["Production index.html does not contain a module entry."], sizes };

  const entry = readFileSync(resolve(dist, script));
  sizes.entryRaw = entry.byteLength;
  sizes.entryGzip = gzipSize(entry);
  if (sizes.entryRaw > budgets.entryRaw || sizes.entryGzip > budgets.entryGzip) {
    problems.push(`Entry bundle exceeds budget: ${sizes.entryRaw} raw / ${sizes.entryGzip} gzip bytes (limit ${budgets.entryRaw} / ${budgets.entryGzip}).`);
  }

  if (styles.length === 0) problems.push("Production index.html links no entry stylesheet.");
  sizes.entryCssGzip = styles.reduce((sum, file) => sum + gzipSize(readFileSync(resolve(dist, file))), 0);
  if (sizes.entryCssGzip > budgets.entryCssGzip) {
    problems.push(`Entry stylesheet exceeds budget: ${sizes.entryCssGzip} gzip bytes (limit ${budgets.entryCssGzip}).`);
  }

  const assets = resolve(dist, "assets");
  const chunks = existsSync(assets) ? readdirSync(assets).filter((file) => file.endsWith(".js")) : [];
  const cache = new Map();
  const read = (file) => {
    if (!cache.has(file)) cache.set(file, existsSync(resolve(assets, file)) ? readFileSync(resolve(assets, file), "utf8") : "");
    return cache.get(file);
  };

  const shell = chunks.find((file) => file.startsWith("DevelopersPage-"));
  if (!shell) problems.push("No DevelopersPage chunk: the portal shell budget cannot be checked.");
  else {
    sizes.portalShellGzip = gzipSize(Buffer.from(read(shell)));
    if (sizes.portalShellGzip > budgets.portalShellGzip) {
      problems.push(`Portal shell chunk ${shell} exceeds budget: ${sizes.portalShellGzip} gzip bytes (limit ${budgets.portalShellGzip}).`);
    }
  }

  const embed = chunks.find((file) => file.startsWith("EmbedPage-"));
  if (!embed) problems.push("No EmbedPage chunk: the /embed wallet check cannot run.");
  else {
    const entryChunk = script.replace(/^assets\//u, "");
    const entrySet = staticClosure(entryChunk, read);
    const initial = [...staticClosure(embed, read)].filter((file) => !entrySet.has(file));
    sizes.embedInitialChunks = initial.length;
    const hits = walletMarkersIn(initial, read);
    if (hits.length > 0) problems.push(`/embed loads wallet code before any click: ${hits.join(", ")}.`);
  }
  return { problems, sizes };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dist = resolve(process.argv[2] ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist"));
  const { problems, sizes } = checkBudgets(dist);
  if (problems.length > 0) throw new Error(`Bundle budget failed:\n- ${problems.join("\n- ")}`);
  console.log(
    `Bundle budgets passed: entry ${sizes.entryRaw} raw / ${sizes.entryGzip} gzip bytes, entry CSS ${sizes.entryCssGzip} gzip bytes, ` +
      `portal shell ${sizes.portalShellGzip} gzip bytes, /embed initial closure ${sizes.embedInitialChunks} chunks without wallet code.`,
  );
}
