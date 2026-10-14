// The bundle budgets the build enforces (portal design PD-7): entry script, entry stylesheet, the portal shell chunk
// and an /embed initial closure without wallet runtimes. Run with
//   node --test apps/web/src/app/routes/__tests__/bundleBudget.test.mjs
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BUDGETS, checkBudgets, staticClosure, staticImports } from "../../../../scripts/check-bundle-budget.mjs";

function fakeDist({ css = "body{color:red}", shell = "export default 1;", embed = 'import"./shared-a.js";export default 1;', extra = {} } = {}) {
  const dist = mkdtempSync(join(tmpdir(), "kletia-budget-"));
  mkdirSync(join(dist, "assets"));
  writeFileSync(
    join(dist, "index.html"),
    '<html><head><script type="module" crossorigin src="/assets/index-a.js"></script><link rel="stylesheet" crossorigin href="/assets/index-a.css"></head></html>',
  );
  writeFileSync(join(dist, "assets/index-a.js"), 'import"./shared-a.js";console.log(1);');
  writeFileSync(join(dist, "assets/index-a.css"), css);
  writeFileSync(join(dist, "assets/shared-a.js"), "export const a=1;");
  writeFileSync(join(dist, "assets/DevelopersPage-a.js"), shell);
  writeFileSync(join(dist, "assets/EmbedPage-a.js"), embed);
  for (const [name, code] of Object.entries(extra)) writeFileSync(join(dist, "assets", name), code);
  return dist;
}

test("budgets: 200,000 / 65,000 entry bytes, 27 KiB entry CSS, 15 KiB portal shell", () => {
  assert.deepEqual({ ...BUDGETS }, { entryRaw: 200_000, entryGzip: 65_000, entryCssGzip: 27_648, portalShellGzip: 15_360 });
});

test("a small build passes every budget", () => {
  const dist = fakeDist();
  try {
    const { problems, sizes } = checkBudgets(dist);
    assert.deepEqual(problems, []);
    assert.ok(sizes.entryCssGzip > 0 && sizes.portalShellGzip > 0);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test("an entry stylesheet over the CSS budget and a heavy portal shell fail", () => {
  // Random bytes do not compress: their gzip size stays above the limits.
  const noise = randomBytes(40_000).toString("base64");
  const dist = fakeDist({ css: `/*${noise}*/`, shell: `export const s="${noise}";` });
  try {
    const { problems } = checkBudgets(dist);
    assert.ok(problems.some((problem) => problem.startsWith("Entry stylesheet exceeds budget")), problems.join("\n"));
    assert.ok(problems.some((problem) => problem.startsWith("Portal shell chunk")), problems.join("\n"));
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test("/embed fails when its static closure carries a wallet runtime, not when it only reads wagmi's storage key", () => {
  const leaking = fakeDist({
    embed: 'import"./walletkit-a.js";export default 1;',
    extra: { "walletkit-a.js": 'export const v="@wagmi/core@2.17.0";' },
  });
  const lazy = fakeDist({
    embed: 'const k=localStorage.getItem("wagmi.recentConnectorId");const load=()=>import("./walletkit-a.js");export default 1;',
    extra: { "walletkit-a.js": 'export const v="@wagmi/core@2.17.0";' },
  });
  try {
    assert.ok(checkBudgets(leaking).problems.some((problem) => problem.includes("/embed loads wallet code")));
    assert.deepEqual(checkBudgets(lazy).problems, []);
  } finally {
    rmSync(leaking, { recursive: true, force: true });
    rmSync(lazy, { recursive: true, force: true });
  }
});

test("static imports are followed; dynamic imports are not", () => {
  assert.deepEqual(staticImports('import{a as b}from"./x.js";import"./y.js";export{c}from"./z.js";import("./lazy.js")').sort(), ["x.js", "y.js", "z.js"]);
  const files = { "a.js": 'import"./b.js";', "b.js": 'import"./a.js";import("./c.js")', "c.js": "" };
  assert.deepEqual([...staticClosure("a.js", (file) => files[file])].sort(), ["a.js", "b.js"]);
});
