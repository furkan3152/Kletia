// Route-chunk check (console design 3.16), run by `npm run build` after the
// entry budget. It reads the route graph the build-only Vite plugin writes
// (vite.config.ts, `kletia-route-graph`): for every route page, its static
// import closure and each dynamic import it reaches with that import's own
// closure. Rules:
//
// 1. No `site` or `embed` route reaches wallet code (wagmi, RainbowKit,
//    WalletConnect, Wallet Standard, @solana/kit, src/app/providers.tsx) in
//    its static closure.
// 2. A site or embed route reaches wallet code through a dynamic import only
//    through its allowed panel: /go LinkSignPanel, /approve ApproveSignPanel,
//    /embed EmbedWalletBar. Studio and every other site page reach none.
// 3. The console route reaches the network engines (console/legacy) and the
//    tool components only through dynamic imports.
//
// Usage: node scripts/check-route-chunks.mjs [route-graph.json]
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_GRAPH = resolve(webRoot, "node_modules/.cache/kletia/route-graph.json");

/** Packages (by name or scope) that are wallet runtimes. */
const WALLET_PACKAGES = [/^wagmi$/u, /^@wagmi\//u, /^@rainbow-me\//u, /^@walletconnect\//u, /^@wallet-standard\//u, /^@solana\/kit$/u, /^@reown\//u];
/** App modules that are wallet code. */
const WALLET_MODULES = ["src/app/providers.tsx"];

/** The only dynamic entries through which a site or embed route may reach wallet code. */
export const WALLET_PANELS = Object.freeze({
  link: ["src/app/pages/link/LinkSignPanel.tsx"],
  approve: ["src/app/pages/approve/ApproveSignPanel.tsx"],
  embed: ["src/app/pages/embed/EmbedWalletBar.tsx"],
});

/** Modules the console route must load lazily: the network engines and the tool components. */
const CONSOLE_LAZY = [/^src\/app\/console\/legacy\//u];

function walletHits({ modules = [], packages = [] }) {
  return [
    ...packages.filter((name) => WALLET_PACKAGES.some((pattern) => pattern.test(name))),
    ...modules.filter((name) => WALLET_MODULES.includes(name)),
  ];
}

/**
 * Checks a route graph; returns the problems (empty when every rule holds).
 * `toolModules` are the catalogue's lazy tool components (src paths without extension).
 */
export function checkRouteGraph(graph, { toolModules = [] } = {}) {
  const problems = [];
  if (!graph || graph.version !== 1 || !Array.isArray(graph.routes) || graph.routes.length === 0) {
    return ["The route graph is missing or empty: build the web app first (npm run build -w @kletia/web)."];
  }
  for (const route of graph.routes) {
    if (!route.module) {
      problems.push(`${route.id}: its page module is not in the build graph.`);
      continue;
    }
    if (route.kind === "site" || route.kind === "embed") {
      const hits = walletHits(route.static);
      if (hits.length > 0) problems.push(`${route.id} (${route.kind}) statically reaches wallet code: ${hits.join(", ")}.`);
      const allowed = WALLET_PANELS[route.id] ?? [];
      for (const dynamic of route.dynamic ?? []) {
        if (allowed.includes(dynamic.entry)) continue;
        const reached = walletHits(dynamic);
        if (reached.length > 0) problems.push(`${route.id} (${route.kind}) reaches wallet code through ${dynamic.entry}: ${reached.join(", ")}.`);
      }
    }
    if (route.kind === "console") {
      const lazyOnly = (name) => CONSOLE_LAZY.some((pattern) => pattern.test(name)) || toolModules.some((tool) => name.replace(/\.(tsx?|jsx?)$/u, "") === tool);
      const eager = (route.static?.modules ?? []).filter(lazyOnly);
      if (eager.length > 0) problems.push(`${route.id}: the engines and tools must load lazily, but the route statically imports ${eager.join(", ")}.`);
    }
  }
  return problems;
}

/** The catalogue's lazy tool components, read from its source (`load: () => import("...")`). */
export function catalogueToolModules(source) {
  return [...source.matchAll(/load:\s*\(\)\s*=>\s*import\("([^"]+)"\)/gu)].map((match) =>
    resolve(webRoot, "src/app/console/tools", match[1]).slice(webRoot.length + 1).split("\\").join("/"),
  );
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const file = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_GRAPH;
  if (!existsSync(file)) {
    console.error(`Route graph not found at ${file}. Build the web app first.`);
    process.exit(1);
  }
  const graph = JSON.parse(readFileSync(file, "utf8"));
  const toolModules = catalogueToolModules(readFileSync(resolve(webRoot, "src/app/console/tools/catalogue.ts"), "utf8"));
  const problems = checkRouteGraph(graph, { toolModules });
  if (problems.length > 0) {
    for (const problem of problems) console.error(`Route-chunk check: ${problem}`);
    process.exit(1);
  }
  console.log(`Route-chunk check passed: ${graph.routes.length} routes, no wallet code on site routes, engines and tools lazy in the console.`);
}
