import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const repositoryRoot = process.cwd();
const failures = [];
let checkedLinks = 0;

function fail(file, message) {
  failures.push(`${file}: ${message}`);
}

const filesResult = spawnSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "*.md"],
  {
  cwd: repositoryRoot,
  encoding: "utf8",
  },
);
if (filesResult.status !== 0) {
  throw new Error("Unable to read the tracked Markdown manifest.");
}

const markdownFiles = filesResult.stdout.split("\0").filter(Boolean);
const requiredDocuments = [
  "README.md",
  "docs/README.md",
  "docs/architecture/overview.md",
  "docs/architecture/repository-structure.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
];

for (const file of requiredDocuments) {
  if (!markdownFiles.includes(file)) fail(file, "required document is not tracked");
}

function withoutFencedCode(source) {
  return source.replace(/^(?: {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?^(?: {0,3})\1\s*$/gmu, "");
}

function githubSlug(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/gu, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s+/gu, "-");
}

function headingIds(source) {
  const identifiers = new Set();
  const occurrences = new Map();
  for (const match of withoutFencedCode(source).matchAll(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/gmu)) {
    const base = githubSlug(match[1]);
    if (!base) continue;
    const count = occurrences.get(base) ?? 0;
    identifiers.add(count === 0 ? base : `${base}-${count}`);
    occurrences.set(base, count + 1);
  }
  return identifiers;
}

function extractTargets(source) {
  const content = withoutFencedCode(source);
  const targets = [];
  for (const match of content.matchAll(/!?\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/gu)) {
    targets.push(match[1] ?? match[2]);
  }
  for (const match of content.matchAll(/<(?:a|img)\b[^>]*\b(?:href|src)=["']([^"']+)["'][^>]*>/giu)) {
    targets.push(match[1]);
  }
  return targets;
}

const sourceCache = new Map();
const headingsCache = new Map();
function readSource(file) {
  if (!sourceCache.has(file)) sourceCache.set(file, readFileSync(file, "utf8"));
  return sourceCache.get(file);
}

for (const file of markdownFiles) {
  const source = readSource(file);

  if (/(?:\/home\/[^/\s]+|\/Users\/[^/\s]+|[A-Za-z]:\\Users\\)/u.test(source)) {
    fail(file, "contains a workstation-specific absolute path");
  }
  if (/github\.com\/ArkMaster123\/Kletia/iu.test(source)) {
    fail(file, "contains the retired GitHub repository owner");
  }

  for (const rawTarget of extractTargets(source)) {
    if (!rawTarget || /^(?:https?:|mailto:|data:|tel:|javascript:)/iu.test(rawTarget)) continue;
    checkedLinks += 1;

    const [rawPath, rawFragment = ""] = rawTarget.split("#", 2);
    const cleanPath = rawPath.split("?", 1)[0];
    let decodedPath;
    let decodedFragment;
    try {
      decodedPath = decodeURIComponent(cleanPath);
      decodedFragment = decodeURIComponent(rawFragment).toLowerCase();
    } catch {
      fail(file, `contains an invalid percent-encoded link: ${rawTarget}`);
      continue;
    }

    const target = decodedPath
      ? path.resolve(
          repositoryRoot,
          decodedPath.startsWith("/")
            ? decodedPath.slice(1)
            : path.join(path.dirname(file), decodedPath),
        )
      : path.resolve(repositoryRoot, file);
    const relativeTarget = path.relative(repositoryRoot, target);
    if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
      fail(file, `link escapes the repository: ${rawTarget}`);
      continue;
    }
    if (!existsSync(target)) {
      fail(file, `link target does not exist: ${rawTarget}`);
      continue;
    }
    if (statSync(target).isDirectory()) {
      fail(file, `link points to a directory instead of a document: ${rawTarget}`);
      continue;
    }
    if (decodedFragment && target.endsWith(".md")) {
      if (!headingsCache.has(target)) {
        headingsCache.set(target, headingIds(readFileSync(target, "utf8")));
      }
      if (!headingsCache.get(target).has(decodedFragment)) {
        fail(file, `heading fragment does not exist: ${rawTarget}`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error("Documentation verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Documentation verification passed (${markdownFiles.length} tracked Markdown files, ${checkedLinks} local links).`,
);
