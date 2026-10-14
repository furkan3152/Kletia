import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error The emitter is a plain Node script without type declarations.
import { embedDevFile } from "./scripts/emit-embed-script.mjs";

const webRoot = dirname(fileURLToPath(import.meta.url));
const ROUTE_TABLE = resolve(webRoot, "src/app/routes/routeTable.ts");
/** Where the route graph goes: a build cache, never published with dist (scripts/check-route-chunks.mjs reads it). */
const ROUTE_GRAPH_FILE = resolve(webRoot, "node_modules/.cache/kletia/route-graph.json");

/** A module id as the route-chunk check reads it: `src/...`, `pkg:<name>` or a repo-relative path. */
function moduleName(id: string): string {
  const clean = id.split("?")[0];
  const marker = `${sep}node_modules${sep}`;
  const at = clean.lastIndexOf(marker);
  if (at >= 0) {
    const parts = clean.slice(at + marker.length).split(sep);
    return `pkg:${parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]}`;
  }
  if (clean.startsWith("\0")) return clean.slice(1);
  const fromWeb = relative(webRoot, clean);
  return fromWeb.startsWith("..") ? relative(resolve(webRoot, "../.."), clean).split(sep).join("/") : fromWeb.split(sep).join("/");
}

/** `kind` and page module of each route, in table order (`load: () => import("...")`). */
function routeEntries(): { id: string; kind: string; specifier: string }[] {
  const source = readFileSync(ROUTE_TABLE, "utf8");
  const start = source.indexOf("export const ROUTES");
  const out: { id: string; kind: string; specifier: string }[] = [];
  const pattern = /\bid:\s*"([^"]+)"[\s\S]*?\bkind:\s*"([^"]+)"[\s\S]*?\bload:\s*\(\)\s*=>\s*import\("([^"]+)"\)/gu;
  for (const match of source.slice(start).matchAll(pattern)) out.push({ id: match[1], kind: match[2], specifier: match[3] });
  return out;
}

/**
 * Build-only plugin: writes, for every route page, the static import
 * closure and each dynamic import reachable from it with that import's own
 * closure, from Rollup's module graph. Chunk files cannot answer this
 * (Vite's preload map links every chunk to every other). The route table's
 * own page imports are navigation, not part of a page, so they are not
 * followed.
 */
function routeGraph(): Plugin {
  return {
    name: "kletia-route-graph",
    apply: "build",
    generateBundle() {
      const routeTableId = [...this.getModuleIds()].find((id) => id.split("?")[0] === ROUTE_TABLE);
      if (!routeTableId) return;
      const info = (id: string) => this.getModuleInfo(id);
      const followDynamic = (id: string): readonly string[] => (id === routeTableId ? [] : (info(id)?.dynamicallyImportedIds ?? []));
      const closure = (start: string, dynamic: boolean): Set<string> => {
        const seen = new Set<string>();
        const stack = [start];
        while (stack.length > 0) {
          const id = stack.pop()!;
          if (seen.has(id)) continue;
          seen.add(id);
          const module = info(id);
          if (!module) continue;
          for (const next of module.importedIds) if (next !== routeTableId) stack.push(next);
          if (dynamic) for (const next of followDynamic(id)) stack.push(next);
        }
        return seen;
      };
      const summary = (ids: Iterable<string>) => {
        const names = [...new Set([...ids].map(moduleName))].sort();
        return { modules: names.filter((name) => !name.startsWith("pkg:")), packages: names.filter((name) => name.startsWith("pkg:")).map((name) => name.slice(4)) };
      };
      const routes = routeEntries().map((route) => {
        const target = resolve(dirname(ROUTE_TABLE), route.specifier);
        const pageId = (info(routeTableId)?.dynamicallyImportedIds ?? []).find((id) => id.split("?")[0].replace(/\.(tsx?|jsx?)$/u, "") === target);
        if (!pageId) return { id: route.id, kind: route.kind, module: null, static: { modules: [], packages: [] }, dynamic: [] };
        const statics = closure(pageId, false);
        const entries = new Set<string>();
        for (const id of statics) for (const next of followDynamic(id)) if (!statics.has(next)) entries.add(next);
        return {
          id: route.id,
          kind: route.kind,
          module: moduleName(pageId),
          static: summary(statics),
          dynamic: [...entries].sort().map((entry) => ({ entry: moduleName(entry), ...summary(closure(entry, true)) })),
        };
      });
      mkdirSync(dirname(ROUTE_GRAPH_FILE), { recursive: true });
      writeFileSync(ROUTE_GRAPH_FILE, `${JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), routes }, null, 1)}\n`);
    },
  };
}

/**
 * Development only: serves `/sdk/embed/<version>/{kletia-embed.min.js,index.js}`
 * and `/sdk/embed/manifest.json` from packages/embed/dist with the headers
 * the production server sends, so the builder and partner pages pin the same
 * integrity locally (the build copies the same files, scripts/emit-embed-script.mjs).
 */
function embedScript(): Plugin {
  return {
    name: "kletia-embed-script",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = (request.url ?? "").split("?")[0] ?? "";
        const file = (embedDevFile as (path: string) => { status: number; body: Buffer; contentType: string } | null)(pathname);
        if (!file) {
          next();
          return;
        }
        response.statusCode = file.status;
        response.setHeader("Content-Type", file.contentType);
        response.setHeader("Access-Control-Allow-Origin", "*");
        response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("Cache-Control", "no-cache");
        response.end(file.body);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), routeGraph(), embedScript()],
  resolve: {
    // Workspace packages (@kletia/widget) must share the app's React instance.
    dedupe: ["react", "react-dom"],
  },
  optimizeDeps: {
    include: ["buffer"],
  },
  // Wallet runtimes load lazily with the console route. A separate
  // post-build budget checks both raw and gzip size of the entry; this limit
  // keeps Vite's generic warning aligned with that explicit release gate.
  build: {
    chunkSizeWarningLimit: 1_200,
  },
  server: {
    port: 5174,
    fs: {
      // Workspace packages (@kletia/core, @kletia/sdk) are linked from ../../packages;
      // the site fonts are hoisted to the root node_modules.
      allow: [".", "../../packages", "../../node_modules/@fontsource-variable"],
    },
  },
});
