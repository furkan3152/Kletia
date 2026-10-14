// The root test scripts cover every test file, and `npm run verify` runs them.
// A web test directory outside the `test:web` globs would silently never run
// (that is how 54 web tests once stayed out of CI). Run with
//   node --test "tooling/__tests__/*.test.mjs"
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const scripts = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).scripts;

/** The quoted glob arguments of a `node --test "…" "…"` script. */
function globsOf(script) {
  assert.match(script, /^node --test /u, `expected a node --test script: ${script}`);
  const globs = [...script.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
  assert.ok(globs.length > 0, `quote the globs so node, not the shell, expands them: ${script}`);
  return globs;
}

/** Files the given globs reach, expanded the way `node --test` expands them. */
function reached(globs) {
  return new Set(globs.flatMap((pattern) => globSync(pattern, { cwd: root })).map((file) => file.replaceAll("\\", "/")));
}

/** Files git tracks or would add (ignored files such as node_modules excluded) that match one pathspec. */
function repositoryFiles(pathspec) {
  const listed = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", pathspec], { cwd: root, encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  return listed.stdout.split("\0").filter((file) => file && existsSync(resolve(root, file)));
}

/** Test files no glob reaches. */
function uncovered(files, globs) {
  const covered = reached(globs);
  return files.filter((file) => !covered.has(file));
}

/** The `npm run …` steps of the verify chain. */
function verifySteps() {
  return scripts.verify.split("&&").map((step) => step.trim().replace(/^npm run /u, "").replace(/\s+--(?:\s.*)?$/u, ""));
}

test("test:web runs every web test file, in src and in scripts", () => {
  const globs = globsOf(scripts["test:web"]);
  assert.ok(globs.includes("apps/web/src/**/__tests__/*.test.mjs"), JSON.stringify(globs));
  assert.ok(globs.includes("apps/web/scripts/__tests__/*.test.mjs"), JSON.stringify(globs));
  const files = repositoryFiles("apps/web/**/*.test.mjs");
  assert.ok(files.length >= 10, `found ${files.length} web test files`);
  assert.deepEqual(uncovered(files, globs), [], "web tests outside the test:web globs never run");
});

test("test:tooling runs every tooling test file", () => {
  const globs = globsOf(scripts["test:tooling"]);
  const files = repositoryFiles("tooling/**/*.test.mjs");
  assert.ok(files.includes("tooling/__tests__/verifyScripts.test.mjs"));
  assert.deepEqual(uncovered(files, globs), []);
});

test("a web test directory outside the globs is reported", () => {
  const globs = globsOf(scripts["test:web"]);
  const outside = "apps/web/src/networks/arc/tests/stray.test.mjs";
  const inside = repositoryFiles("apps/web/src/**/__tests__/*.test.mjs")[0];
  assert.ok(inside);
  assert.deepEqual(uncovered([inside, outside], globs), [outside]);
  // The narrow glob this repository once used misses tests outside the embed page.
  assert.ok(uncovered(repositoryFiles("apps/web/**/*.test.mjs"), ["apps/web/src/app/pages/embed/__tests__/*.test.mjs"]).length > 0);
});

test("verify runs the web, tooling, API, package and contract tests", () => {
  const steps = verifySteps();
  for (const step of ["test:packages", "test:api", "test:web", "test:tooling", "test:contracts", "check:openapi"]) {
    assert.ok(steps.includes(step), `verify runs ${step}`);
  }
  for (const step of steps) assert.ok(scripts[step] !== undefined, `verify step ${step} is a root script`);
});

test("test:contracts runs both contract workspaces, which define a hardhat test script", () => {
  assert.equal(scripts["test:contracts"], "npm --prefix contracts/base test && npm --prefix contracts/arc test");
  for (const workspace of ["contracts/base", "contracts/arc"]) {
    const manifest = JSON.parse(readFileSync(resolve(root, workspace, "package.json"), "utf8"));
    assert.equal(manifest.scripts.test, "hardhat test --network hardhat", workspace);
    assert.ok(repositoryFiles(`${workspace}/test/*.test.js`).length > 0, `${workspace} has tests`);
  }
});

test("the docs check bans Solana-first positioning and requires every docs/platform page in the index", async () => {
  const { bannedPhraseProblems, unindexedPlatformPages } = await import("../verify-documentation.mjs");
  assert.equal(bannedPhraseProblems("Kletia is Solana-first.").length, 1);
  assert.equal(bannedPhraseProblems("solana-FIRST").length, 1);
  assert.deepEqual(bannedPhraseProblems("Kletia runs on nine networks."), []);
  const files = ["docs/platform/journey.md", "docs/platform/clarify.md", "docs/networks/solana.md"];
  assert.deepEqual(unindexedPlatformPages(files, "- [Journey](platform/journey.md)"), ["docs/platform/clarify.md"]);
  assert.deepEqual(unindexedPlatformPages(files, "[J](platform/journey.md) [C](platform/clarify.md#threads)"), []);
});
