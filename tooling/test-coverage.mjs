#!/usr/bin/env node
// Runs the API and package test suites under Node's built-in coverage and
// prints line/branch coverage per area. Informational only: the exit code is
// the test result, never a coverage threshold. Packages are measured through
// their built dist (source maps point back at src), so run
// `npm run build:packages` first.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const PACKAGES = ["core", "sdk", "widget", "embed", "cli"];

/** Areas reported for the API, most specific prefix first; the first match wins. */
export const API_AREAS = [
  "src/platform/http",
  "src/platform/engine/adapters",
  "src/platform/engine",
  "src/admin",
  "src",
];

/** Summed line/branch counters per source file from an lcov document. */
export function parseLcov(source) {
  const files = [];
  let current = null;
  for (const line of source.split("\n")) {
    if (line.startsWith("SF:")) current = { file: line.slice(3), lines: [0, 0], branches: [0, 0] };
    else if (!current) continue;
    else if (line.startsWith("LF:")) current.lines[1] = Number(line.slice(3));
    else if (line.startsWith("LH:")) current.lines[0] = Number(line.slice(3));
    else if (line.startsWith("BRF:")) current.branches[1] = Number(line.slice(4));
    else if (line.startsWith("BRH:")) current.branches[0] = Number(line.slice(4));
    else if (line === "end_of_record") {
      files.push(current);
      current = null;
    }
  }
  return files;
}

/** Totals per area; files outside every area and test files are left out. */
export function summarize(files, areas) {
  const totals = new Map(areas.map((area) => [area, { lines: [0, 0], branches: [0, 0] }]));
  for (const entry of files) {
    const file = entry.file.split(path.sep).join("/");
    if (/(^|\/)(__tests__|test|node_modules)\//u.test(file)) continue;
    const area = areas.find((prefix) => file.startsWith(`${prefix}/`));
    if (!area) continue;
    const total = totals.get(area);
    for (const key of ["lines", "branches"]) {
      total[key][0] += entry[key][0];
      total[key][1] += entry[key][1];
    }
  }
  return totals;
}

/** The lcov a run wrote; empty when the run wrote none (it failed early). */
const readLcov = (file) => (existsSync(file) ? parseLcov(readFileSync(file, "utf8")) : []);

const percent = ([hit, found]) => (found === 0 ? "n/a" : `${((hit / found) * 100).toFixed(2)}%`);

/** Markdown rows: area | lines | branches. */
export function formatRows(label, totals) {
  return [...totals].map(
    ([area, { lines, branches }]) =>
      `| ${label}/${area} | ${percent(lines)} (${lines[0]}/${lines[1]}) | ${percent(branches)} (${branches[0]}/${branches[1]}) |`,
  );
}

function run(cwd, lcov, args) {
  const result = spawnSync(
    process.execPath,
    [
      "--enable-source-maps",
      "--experimental-test-coverage",
      "--test-reporter=dot",
      "--test-reporter-destination=stdout",
      "--test-reporter=lcov",
      `--test-reporter-destination=${lcov}`,
      ...args,
    ],
    { cwd, stdio: ["ignore", "inherit", "inherit"] },
  );
  return result.status ?? 1;
}

function main() {
  const directory = mkdtempSync(path.join(tmpdir(), "kletia-coverage-"));
  const rows = [];
  let status = 0;
  try {
    const apiLcov = path.join(directory, "api.lcov");
    status = run(path.join(root, "apps/api"), apiLcov, [
      "--import",
      "tsx",
      "--test",
      "src/platform/engine/__tests__/*.test.ts",
      "src/platform/http/__tests__/*.test.ts",
      "src/admin/__tests__/*.test.ts",
    ]);
    rows.push(...formatRows("apps/api", summarize(readLcov(apiLcov), API_AREAS)));
    for (const name of PACKAGES) {
      const lcov = path.join(directory, `${name}.lcov`);
      const code = run(path.join(root, "packages", name), lcov, ["--test", "test/*.test.mjs"]);
      status ||= code;
      rows.push(...formatRows(`packages/${name}`, summarize(readLcov(lcov), ["src"])));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  console.log(["", "| Area | Lines | Branches |", "|---|---|---|", ...rows].join("\n"));
  process.exitCode = status;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
