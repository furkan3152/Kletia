import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Written version pins (`@kletia/embed@0.1.0`, in prose or code) in Markdown
 * and in the web app's snippets must name the version the workspace package
 * has, so docs never point at a release that does not exist.
 */
const PIN_PATTERN = /@kletia\/([a-z0-9-]+)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/gu;
/** The embed script served by the Kletia origin names its version in the path: /sdk/embed/<version>/kletia-embed.min.js. */
const EMBED_PATH_PATTERN = /\/sdk\/embed\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\//gu;
/** Source files outside Markdown whose pins are checked too. */
export const PINNED_SOURCES = ["apps/web/src/app/site/snippets.ts"];

/** `@kletia/<name>` → version, from every workspace package.json under packages/. */
export function workspaceVersions(root) {
  const versions = new Map();
  const packagesDirectory = path.join(root, "packages");
  if (!existsSync(packagesDirectory)) return versions;
  for (const entry of readdirSync(packagesDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = path.join(packagesDirectory, entry.name, "package.json");
    if (!existsSync(manifest)) continue;
    const { name, version } = JSON.parse(readFileSync(manifest, "utf8"));
    if (typeof name === "string" && name.startsWith("@kletia/") && typeof version === "string") versions.set(name, version);
  }
  return versions;
}

/** One message per pin in `source` that names an unknown package or another version than the workspace's. */
export function versionPinMismatches(source, versions) {
  const problems = [];
  for (const match of source.matchAll(PIN_PATTERN)) {
    const name = `@kletia/${match[1]}`;
    const expected = versions.get(name);
    if (!expected) problems.push(`pins ${match[0]}, but no workspace package is named ${name}`);
    else if (expected !== match[2]) problems.push(`pins ${match[0]}, but ${name} is ${expected}`);
  }
  const embed = versions.get("@kletia/embed");
  for (const match of source.matchAll(EMBED_PATH_PATTERN)) {
    if (embed && match[1] !== embed) problems.push(`links ${match[0]}, but @kletia/embed is ${embed}`);
  }
  return problems;
}

/** The documentation check: required documents, local links and anchors, workstation paths and version pins. */
function main() {
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

  const versions = workspaceVersions(repositoryRoot);
  let checkedPins = 0;
  for (const file of [...markdownFiles, ...PINNED_SOURCES]) {
    if (!existsSync(file)) continue;
    const source = readSource(file);
    checkedPins += [...source.matchAll(PIN_PATTERN)].length + [...source.matchAll(EMBED_PATH_PATTERN)].length;
    for (const problem of versionPinMismatches(source, versions)) fail(file, problem);
  }

  if (failures.length > 0) {
    console.error("Documentation verification failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log(
    `Documentation verification passed (${markdownFiles.length} tracked Markdown files, ${checkedLinks} local links, ${checkedPins} version pins).`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
