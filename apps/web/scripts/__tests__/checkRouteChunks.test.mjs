// The route-chunk check: wallet code never reaches a site route except
// through the allowed panels, and the console loads its engines and tools
// lazily. The "before" graph is the shape of the build before Studio
// handed off to the desk: /studio reached src/app/providers.tsx through
// its lazily loaded wallet execution panel.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { catalogueToolModules, checkRouteGraph, WALLET_PANELS } from "../check-route-chunks.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const none = { modules: [], packages: [] };
const wallet = { modules: ["src/app/providers.tsx", "src/shared/wallet/x.ts"], packages: ["wagmi", "@rainbow-me/rainbowkit", "@solana/kit"] };

function graph({ studioPanel = false, homeStatic = none, consoleStatic = ["src/app/routes/ConsoleRoute.tsx", "src/app/console/DeskApp.tsx"] } = {}) {
  return {
    version: 1,
    routes: [
      { id: "home", kind: "site", module: "src/app/pages/home/HomePage.tsx", static: homeStatic, dynamic: [] },
      {
        id: "studio",
        kind: "site",
        module: "src/app/pages/studio/StudioPage.tsx",
        static: { modules: ["src/app/pages/studio/StudioPage.tsx"], packages: ["react"] },
        dynamic: studioPanel ? [{ entry: "src/app/pages/studio/StudioExecutionPanel.tsx", ...wallet }] : [],
      },
      { id: "link", kind: "site", module: "src/app/pages/link/LinkPage.tsx", static: none, dynamic: [{ entry: "src/app/pages/link/LinkSignPanel.tsx", ...wallet }] },
      { id: "approve", kind: "site", module: "src/app/pages/approve/ApprovePage.tsx", static: none, dynamic: [{ entry: "src/app/pages/approve/ApproveSignPanel.tsx", ...wallet }] },
      { id: "embed", kind: "embed", module: "src/app/pages/embed/EmbedPage.tsx", static: none, dynamic: [{ entry: "src/app/pages/embed/EmbedWalletBar.tsx", ...wallet }] },
      { id: "console", kind: "console", module: "src/app/routes/ConsoleRoute.tsx", static: { modules: consoleStatic, packages: ["wagmi"] }, dynamic: [] },
    ],
  };
}

test("the build before the Studio hand-off fails: /studio reaches the wallet providers through its execution panel", () => {
  const problems = checkRouteGraph(graph({ studioPanel: true }));
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /^studio \(site\) reaches wallet code through src\/app\/pages\/studio\/StudioExecutionPanel\.tsx: wagmi, @rainbow-me\/rainbowkit, @solana\/kit, src\/app\/providers\.tsx\.$/u);
});

test("after the hand-off every rule holds: only /go, /approve and /embed reach wallet code, through their panels", () => {
  assert.deepEqual(checkRouteGraph(graph()), []);
  assert.deepEqual(Object.keys(WALLET_PANELS).sort(), ["approve", "embed", "link"]);
});

test("a site route that imports wallet code statically fails, whatever the route", () => {
  const problems = checkRouteGraph(graph({ homeStatic: { modules: [], packages: ["@wagmi/core"] } }));
  assert.deepEqual(problems, ["home (site) statically reaches wallet code: @wagmi/core."]);
});

test("an allowed panel is allowed only on its own route", () => {
  const moved = graph();
  moved.routes[0].dynamic = [{ entry: "src/app/pages/link/LinkSignPanel.tsx", ...wallet }];
  assert.equal(checkRouteGraph(moved).length, 1);
});

test("the console must load the engines and the tool components lazily", () => {
  const toolModules = ["src/networks/solana/components/SolanaSwap"];
  assert.deepEqual(checkRouteGraph(graph(), { toolModules }), []);
  const eager = checkRouteGraph(graph({ consoleStatic: ["src/app/routes/ConsoleRoute.tsx", "src/app/console/legacy/useLegacyEngine.ts", "src/networks/solana/components/SolanaSwap.tsx"] }), { toolModules });
  assert.equal(eager.length, 1);
  assert.match(eager[0], /src\/app\/console\/legacy\/useLegacyEngine\.ts, src\/networks\/solana\/components\/SolanaSwap\.tsx/u);
});

test("a missing or empty graph fails closed", () => {
  assert.equal(checkRouteGraph(null).length, 1);
  assert.equal(checkRouteGraph({ version: 1, routes: [] }).length, 1);
  const unknown = graph();
  unknown.routes[1].module = null;
  assert.match(checkRouteGraph(unknown)[0], /studio: its page module is not in the build graph/u);
});

test("the catalogue's lazy tool components are read from its source", () => {
  const source = readFileSync(resolve(here, "../../src/app/console/tools/catalogue.ts"), "utf8");
  const modules = catalogueToolModules(source);
  assert.ok(modules.includes("src/networks/solana/components/SolanaSwap"), modules.join(", "));
  assert.ok(modules.includes("src/networks/base/components/x402/X402ServiceRouter"));
  assert.equal(modules.length, 11);
});

test("the web build runs the check after the entry budget", () => {
  const scripts = JSON.parse(readFileSync(resolve(here, "../../package.json"), "utf8")).scripts;
  assert.match(scripts.build, /check-bundle-budget\.mjs && node scripts\/check-route-chunks\.mjs$/u);
  assert.match(readFileSync(resolve(here, "../../vite.config.ts"), "utf8"), /apply: "build"/u);
});
