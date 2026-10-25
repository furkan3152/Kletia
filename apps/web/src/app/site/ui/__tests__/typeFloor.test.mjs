// The 12 px type floor: nothing a user must read in site/ui or the developer portal is
// smaller than 12 px; smaller print is for aria-hidden ornament only (site/art is all ornament and is not
// scanned). Run with Node 22.18 or later:
//   node --test apps/web/src/app/site/ui/__tests__/typeFloor.test.mjs
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import tailwindConfig from "../../../../../tailwind.config.js";

const APP = fileURLToPath(new URL("../../../", import.meta.url));
/** The desk's views are scanned too; console/legacy is the old engine UI and is not. */
const SCANNED = ["site/ui", "pages/developers", ...["activity", "automations", "composer", "dashboard", "holdings", "orders", "perps", "predict", "shell", "tasks", "tools"].map((part) => `console/${part}`)];

/**
 * Files that still print readable text under 12 px, each with the release
 * that rebuilds it. The count may only go down: a new file, or a file
 * over its count, fails. Release removes this list.
 */
const PENDING = {
  "pages/developers/components/MethodBadge.tsx": [1, "release"],
  "site/ui/CopyButton.tsx": [1, "release"],
  "site/ui/StatusDot.tsx": [1, "release"],
};

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : walk(path);
    return /\.(ts|tsx)$/u.test(entry.name) ? [path] : [];
  });
}

/** Index of the `>` that closes the JSX opening tag starting at `start` (strings and `{}` skipped), or -1. */
function tagEnd(source, start) {
  let depth = 0;
  let quote = null;
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    else if (char === ">" && depth === 0) return index;
  }
  return -1;
}

/** True when the class at `index` sits in the opening tag of an element marked aria-hidden (ornament). */
function inHiddenTag(source, index) {
  const start = source.lastIndexOf("<", index);
  if (start < 0 || !/[A-Za-z]/u.test(source[start + 1] ?? "")) return false;
  const end = tagEnd(source, start);
  if (end < index) return false;
  return /\saria-hidden(?:=(?:"true"|\{true\})|[\s/>])/u.test(source.slice(start, end + 1));
}

/** Readable font sizes under 12 px: `text-[Npx]` and `text-[Nrem]` outside aria-hidden ornament. */
function smallText(source) {
  const hits = [];
  for (const match of source.matchAll(/(?<![\w-])!?text-\[(\d+(?:\.\d+)?)(px|rem)\]/gu)) {
    const px = match[2] === "rem" ? Number(match[1]) * 16 : Number(match[1]);
    if (px >= 12 || inHiddenTag(source, match.index)) continue;
    hits.push(`${match[0]} at line ${source.slice(0, match.index).split("\n").length}`);
  }
  return hits;
}

const found = new Map();
for (const directory of SCANNED) {
  for (const file of walk(join(APP, directory))) {
    const hits = smallText(readFileSync(file, "utf8"));
    if (hits.length > 0) found.set(relative(APP, file).split("\\").join("/"), hits);
  }
}

test("no readable text under 12 px in site/ui, the developer portal and the desk views, beyond the pending files", () => {
  const problems = [];
  for (const [file, hits] of found) {
    const pending = PENDING[file];
    if (!pending) problems.push(`${file}: ${hits.join(", ")}`);
    else if (hits.length > pending[0]) problems.push(`${file} (pending, ${pending[1]}): ${hits.length} > ${pending[0]}: ${hits.join(", ")}`);
  }
  assert.deepEqual(problems, []);
});

test("the pending list only shrinks: lower a count, or drop the entry, when a file improves", () => {
  const stale = [];
  for (const [file, [count, owner]] of Object.entries(PENDING)) {
    const now = found.get(file)?.length ?? 0;
    if (now < count) stale.push(`${file} (${owner}) now has ${now} readable sizes under 12 px: set its count to ${now}${now === 0 ? " (delete the entry)" : ""}`);
  }
  assert.deepEqual(stale, []);
});

test("the shared label recipe and every font size token are at least 12 px", () => {
  const styles = readFileSync(join(APP, "site/ui/styles.ts"), "utf8");
  const label = /export const LABEL = "([^"]+)";/u.exec(styles)?.[1];
  assert.ok(label, "LABEL is missing from site/ui/styles.ts");
  assert.match(label, /\btext-label\b/u);
  assert.doesNotMatch(label, /text-\[/u);
  const sizes = tailwindConfig.theme.extend.fontSize;
  for (const [name, [size]] of Object.entries(sizes)) {
    const rem = /^([\d.]+)rem$/u.exec(size)?.[1];
    if (rem) assert.ok(Number(rem) * 16 >= 12, `fontSize.${name} is ${size}`);
  }
  assert.equal(sizes.label[0], "0.75rem");
  assert.equal(sizes.label[1].letterSpacing, "0.08em");
});

test("the scanner tells ornament from text", () => {
  assert.deepEqual(smallText('<span aria-hidden="true" className="text-[9px]">PLATFORM</span>'), []);
  assert.deepEqual(smallText('<span\n  aria-hidden\n  className={cx("font-code text-[10px]", x > 1 && "y")}\n/>'), []);
  assert.equal(smallText('<span className="text-[10px]" aria-hidden={false}>Label</span>').length, 1);
  assert.equal(smallText('<p className="!text-[11px] uppercase">Base URL</p>').length, 1);
  assert.equal(smallText('const SMALL = "text-[0.6rem]";').length, 1);
  assert.deepEqual(smallText('<p className="text-[12px] text-[12.5px] text-xs">ok</p>'), []);
});
