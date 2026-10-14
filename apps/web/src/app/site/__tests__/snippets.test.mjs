// Snippet hygiene: the embed version comes from the package, the script is served by the
// Kletia origin, shell continuations are real backslashes, recipe lines stay readable, the quickstart runs as
// pasted, and the docs check catches a stale version pin. Run with Node 22.18 or later:
//   node --test apps/web/src/app/site/__tests__/snippets.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  EMBED_SCRIPT_URL,
  EMBED_VERSION,
  MCP_TOOLS,
  RECIPES,
  REST_CREATE_INTENT,
  SDK_QUICKSTART,
  WEB_BASE_URL,
} from "../snippets.ts";
import { versionPinMismatches, workspaceVersions } from "../../../../../../tooling/verify-documentation.mjs";

const ROOT = fileURLToPath(new URL("../../../../../../", import.meta.url));
const SOURCE = readFileSync(fileURLToPath(new URL("../snippets.ts", import.meta.url)), "utf8");
const EMBED_PACKAGE = JSON.parse(readFileSync(join(ROOT, "packages/embed/package.json"), "utf8"));

const recipeFiles = RECIPES.flatMap((recipe) => recipe.files.map((file) => ({ recipe: recipe.id, file: file.id, code: file.code })));

test("the embed version is the package's own, and the script comes from the Kletia origin", () => {
  assert.equal(EMBED_VERSION, EMBED_PACKAGE.version);
  assert.match(SOURCE, /from "@kletia\/embed\/package\.json" with \{ type: "json" \}/u);
  assert.doesNotMatch(SOURCE, /EMBED_VERSION(?::\s*string)?\s*=\s*"/u, "no hand-written version");
  assert.equal(EMBED_SCRIPT_URL, `${WEB_BASE_URL}/sdk/embed/${EMBED_PACKAGE.version}/kletia-embed.min.js`);
  const html = RECIPES.find((recipe) => recipe.id === "web-component").files.find((file) => file.id === "html").code;
  assert.ok(html.includes(`<script src="${EMBED_SCRIPT_URL}" crossorigin="anonymous"></script>`), html);
  assert.ok(!/cdn\.jsdelivr|unpkg\.com/u.test(SOURCE), "no third-party CDN");
});

test("shell continuations are backslashes and every recipe line is at most 140 characters", () => {
  const problems = [];
  for (const { recipe, file, code } of recipeFiles) {
    const lines = code.split("\n");
    lines.forEach((line, index) => {
      if (line.length > 140) problems.push(`${recipe}/${file}:${index + 1} is ${line.length} characters`);
      // A template literal's lone backslash joins lines: "…base:0xYou   --expires 7d".
      if (/\S {2,}--[a-z]/u.test(line)) problems.push(`${recipe}/${file}:${index + 1} joins a continuation: ${line.slice(0, 80)}`);
      if (/^\s+--[a-z]/u.test(line) && index > 0 && !/\\$/u.test(lines[index - 1])) {
        problems.push(`${recipe}/${file}:${index + 1} continues a line that does not end with a backslash`);
      }
    });
  }
  for (const [name, code] of [["REST_CREATE_INTENT", REST_CREATE_INTENT]]) {
    for (const line of code.split("\n").slice(0, -1)) if (/^curl|^\s+-[Hd]/u.test(line) && !line.includes("'")) assert.match(line, /\\$/u, name);
  }
  assert.deepEqual(problems, []);
});

test("journey and questions recipes are platform features with code", () => {
  for (const id of ["journey", "questions"]) {
    const recipe = RECIPES.find((item) => item.id === id);
    assert.ok(recipe, id);
    assert.equal(recipe.group, "Platform features");
    assert.ok(recipe.files.length >= 2 && recipe.notes.length >= 3, id);
  }
  const journey = RECIPES.find((item) => item.id === "journey").files.map((file) => file.code).join("\n");
  assert.match(journey, /journey: true/u);
  assert.match(journey, /journey\.blockers/u);
  assert.match(journey, /journeyAnswers/u);
  assert.match(journey, /\/v1\/intents\/\$INTENT_ID\/stop/u);
  const questions = RECIPES.find((item) => item.id === "questions").files.map((file) => file.code).join("\n");
  assert.match(questions, /clarify=true/u);
  assert.match(questions, /needs_input/u);
  assert.match(questions, /thread: turn\.thread/u);
  assert.ok(MCP_TOOLS.some((tool) => tool.name === "get_journey"));
});

test("no snippet carries a key: secrets come from the environment", () => {
  const everything = [SOURCE, ...recipeFiles.map((item) => item.code)].join("\n");
  assert.doesNotMatch(everything, /kl_(?:dev|agt|pub)_[0-9A-Za-z]{32}/u);
  assert.doesNotMatch(everything, /apiKey:\s*"/u);
  assert.match(SDK_QUICKSTART, /process\.env\.KLETIA_API_KEY/u);
});

test("the quickstart runs as pasted against a stand-in SDK", () => {
  const directory = mkdtempSync(join(tmpdir(), "kletia-quickstart-"));
  try {
    const sdk = join(directory, "node_modules", "@kletia", "sdk");
    mkdirSync(sdk, { recursive: true });
    writeFileSync(join(sdk, "package.json"), JSON.stringify({ name: "@kletia/sdk", type: "module", main: "index.js" }));
    writeFileSync(
      join(sdk, "index.js"),
      `export class KletiaClient {
  constructor(options = {}) { this.options = options; }
  async networks() { return [{ name: "Solana", actions: ["swap", "stake"] }]; }
  intents = {
    create: async (request, options) => {
      if (options?.dryRun !== true) throw new Error("the quickstart must plan a dry run");
      if (!Array.isArray(request.accounts) || !/^solana:/.test(request.accounts[0])) throw new Error("no account");
      return { steps: [{ title: "Swap 1 SOL for USDC", expectedOutput: { formatted: "105.7", symbol: "USDC" } }] };
    },
  };
}
`,
    );
    writeFileSync(join(directory, "quickstart.mjs"), SDK_QUICKSTART);
    const env = { ...process.env };
    delete env.KLETIA_API_KEY;
    delete env.KLETIA_ACCOUNT;
    const run = spawnSync(process.execPath, ["quickstart.mjs"], { cwd: directory, encoding: "utf8", env });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Solana: swap, stake/u);
    assert.match(run.stdout, /Swap 1 SOL for USDC 105\.7 USDC/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the docs check flags a pinned version that differs from the package", () => {
  const versions = workspaceVersions(ROOT);
  assert.equal(versions.get("@kletia/embed"), EMBED_PACKAGE.version);
  assert.deepEqual(versionPinMismatches(`npm install @kletia/embed@${EMBED_PACKAGE.version}`, versions), []);
  const stale = versionPinMismatches("<script src=\"https://cdn.example/@kletia/embed@9.9.9/dist/index.js\">", versions);
  assert.equal(stale.length, 1);
  assert.match(stale[0], /@kletia\/embed@9\.9\.9, but @kletia\/embed is /u);
  assert.equal(versionPinMismatches("npm i @kletia/nothing@1.0.0", versions).length, 1);
  assert.deepEqual(versionPinMismatches(`<script src="https://kletiaai.xyz/sdk/embed/${EMBED_PACKAGE.version}/kletia-embed.min.js">`, versions), []);
  assert.match(versionPinMismatches("https://kletiaai.xyz/sdk/embed/0.0.9/kletia-embed.min.js", versions)[0], /\/sdk\/embed\/0\.0\.9\//u);
  assert.deepEqual(versionPinMismatches(SOURCE, versions), [], "snippets.ts pins only real versions");
  const check = spawnSync(process.execPath, ["tooling/verify-documentation.mjs"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /version pins/u);
});
