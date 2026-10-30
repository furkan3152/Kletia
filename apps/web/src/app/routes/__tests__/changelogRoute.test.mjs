// /changelog: a site route written by write-route-pages, listed in the sitemap and linked from the footer,
// rendering CHANGELOG.md newest first with an anchor per release; and there is no pricing page. Run with
//   node --test apps/web/src/app/routes/__tests__/changelogRoute.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { isNewestFirst, parseChangelog, parseInline, releaseAnchor, safeHref } from "../../pages/changelog/changelogModel.ts";
import { matchRoute, ROUTES } from "../routeTable.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const sitemap = read("../../../../public/sitemap.xml");
const footer = read("../../site/SiteFooter.tsx");
const changelog = read("../../../../../../CHANGELOG.md");

test("/changelog is an indexed site route with its own fixed path (written as HTML by write-route-pages)", () => {
  const route = matchRoute("/changelog");
  assert.equal(route.id, "changelog");
  assert.equal(route.kind, "site");
  assert.equal(route.path, "/changelog");
  assert.equal(route.canonicalFromPath, undefined, "a fixed path: write-route-pages writes changelog.html");
  assert.equal(route.robots, undefined);
  assert.ok(route.title.length > 0 && route.description.length >= 50);
  assert.equal(matchRoute("/changelog/v1").id, "notFound");
});

test("the sitemap lists /changelog and the footer links it; there is no pricing page", () => {
  assert.ok(sitemap.includes("<loc>https://kletiaai.xyz/changelog</loc>"));
  assert.match(footer, /to: "\/changelog"/u);
  assert.equal(matchRoute("/pricing").id, "notFound");
  assert.ok(!Object.values(ROUTES).some((route) => /pricing/iu.test(route.path)));
  assert.ok(!sitemap.includes("pricing"));
});

test("CHANGELOG.md parses into releases, newest first, each with a unique anchor", () => {
  const parsed = parseChangelog(changelog);
  assert.ok(parsed.releases.length >= 2);
  assert.ok(isNewestFirst(parsed.releases));
  assert.equal(new Set(parsed.releases.map((release) => release.id)).size, parsed.releases.length);
  for (const release of parsed.releases) assert.match(release.id, /^[a-z][a-z0-9-]*$/u);
  assert.ok(parsed.releases.some((release) => release.sections.some((section) => section.title === "Added")));
  assert.equal(releaseAnchor("2.0.0"), "v2-0-0");
  assert.equal(releaseAnchor("Unreleased"), "unreleased");
});

test("a small changelog keeps its order, sections, notes and inline formatting", () => {
  const parsed = parseChangelog(
    [
      "# Changelog",
      "",
      "Intro with a [link](https://keepachangelog.com/).",
      "",
      "## [Unreleased]",
      "",
      "### Added",
      "",
      "- One `code` item and **bold**.",
      "- Two",
      "  wrapped.",
      "",
      "A note for the next group.",
      "",
      "### Fixed",
      "",
      "- Three, see [the guide](docs/platform/api-v1.md).",
      "",
      "## [1.1.0] - 2026-10-01",
      "",
      "### Changed",
      "",
      "- Four",
      "",
      "## [1.0.0] - 2026-09-01",
      "",
      "- Five",
    ].join("\n"),
  );
  assert.equal(parsed.intro.length, 1);
  assert.deepEqual(parsed.releases.map((release) => [release.version, release.date, release.id]), [
    ["Unreleased", null, "unreleased"],
    ["1.1.0", "2026-10-01", "v1-1-0"],
    ["1.0.0", "2026-09-01", "v1-0-0"],
  ]);
  const [added, note, fixed] = parsed.releases[0].sections;
  assert.equal(added.title, "Added");
  assert.equal(added.blocks[0].items.length, 2);
  assert.deepEqual(added.blocks[0].items[1], [{ kind: "text", text: "Two wrapped." }]);
  assert.deepEqual(added.blocks[0].items[0], [
    { kind: "text", text: "One " },
    { kind: "code", text: "code" },
    { kind: "text", text: " item and " },
    { kind: "strong", text: "bold" },
    { kind: "text", text: "." },
  ]);
  assert.equal(note.title, null);
  assert.equal(note.blocks[0].kind, "paragraph");
  assert.equal(fixed.title, "Fixed");
  assert.equal(fixed.blocks[0].items[0][1].href, "https://github.com/furkan3152/Kletia/blob/main/docs/platform/api-v1.md");
  assert.equal(isNewestFirst(parsed.releases), true);
  assert.equal(isNewestFirst([{ date: "2026-01-01" }, { date: "2026-02-01" }]), false);
});

test("links keep only https targets and repository paths; nothing becomes markup", () => {
  assert.equal(safeHref("javascript:alert(1)"), null);
  assert.equal(safeHref("http://example.org"), null);
  assert.equal(safeHref("data:text/html,x"), null);
  assert.equal(safeHref("../../etc/passwd"), null);
  assert.equal(safeHref("https://example.org/x"), "https://example.org/x");
  assert.ok(parseInline("[x](javascript:alert(1))").every((part) => part.kind === "text"));
  assert.ok(parseInline("[x](http://example.org)").every((part) => part.kind === "text"));
  assert.equal(parseInline("<img src=x onerror=alert(1)>")[0].kind, "text");
});
