// The /changelog navigation follows the file's own headings: plain "## Round 7"
// headings are releases of their own instead of being folded into the release above them, and
// the Unreleased entry names its round. Run with
//   node --test apps/web/src/app/pages/changelog/__tests__/changelogNav.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { isNewestFirst, parseChangelog, releaseNavLabel } from "../changelogModel.ts";

const changelog = readFileSync(new URL("../../../../../../../CHANGELOG.md", import.meta.url), "utf8");

test("every ## heading of CHANGELOG.md is one release in the navigation, in file order", () => {
  const headings = [...changelog.matchAll(/^##\s+(.+?)\s*$/gmu)].map((match) => match[1].replace(/^\[([^\]]+)\](?:\s+-\s+\S+)?$/u, "$1"));
  const releases = parseChangelog(changelog).releases;
  assert.deepEqual(
    releases.map((release) => release.version),
    headings,
  );
  assert.ok(isNewestFirst(releases));
});

test("plain and bracketed headings, dates, and the round named by an opening note", () => {
  const parsed = parseChangelog(
    [
      "# Changelog",
      "",
      "## [Unreleased]",
      "",
      "Round 8: an admin panel.",
      "",
      "### Added",
      "",
      "- One",
      "",
      "## Round 7",
      "",
      "Round 7: a new engine.",
      "",
      "### Fixed",
      "",
      "- Two",
      "",
      "## Round 6 - 2026-10-12",
      "",
      "- Three",
      "",
      "## [2.0.0] - 2026-10-08",
      "",
      "### Added",
      "",
      "- Four",
    ].join("\n"),
  );
  assert.deepEqual(
    parsed.releases.map((release) => [release.version, release.date, release.id, release.round, releaseNavLabel(release)]),
    [
      ["Unreleased", null, "unreleased", "Round 8", "Unreleased · Round 8"],
      ["Round 7", null, "round-7", null, "Round 7"],
      ["Round 6", "2026-10-12", "round-6", null, "Round 6"],
      ["2.0.0", "2026-10-08", "v2-0-0", null, "2.0.0"],
    ],
  );
  assert.equal(parsed.releases[1].sections.find((section) => section.title === "Fixed").blocks[0].items.length, 1);
});
