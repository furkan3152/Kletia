// The embed script from the Kletia origin: the build copies
// packages/embed/dist under /sdk/embed/<version>/ and the manifest's
// integrity is the SHA-384 of exactly those bytes, with one version
// source (packages/embed/package.json = EMBED_VERSION).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { EMBED_FILES, embedDevFile, emitEmbedScript, embedVersion, sriSha384 } from "../emit-embed-script.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const realEmbed = resolve(here, "../../../../packages/embed");

function fakePackage(version, builtFor = version) {
  const root = mkdtempSync(join(tmpdir(), "kletia-embed-pkg-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@kletia/embed", version }));
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "dist/kletia-embed.min.js"), `/*! @kletia/embed ${builtFor} | MIT */\nvar KletiaEmbed=(()=>{var U=${JSON.stringify(builtFor)};})();\n`);
  writeFileSync(join(root, "dist/index.js"), `/*! @kletia/embed ${builtFor} | MIT */\nexport const EMBED_VERSION = ${JSON.stringify(builtFor)};\n`);
  return root;
}

test("copies both files under the version and writes a manifest whose integrity is the SHA-384 of each file", () => {
  const packageRoot = fakePackage("1.2.3");
  const distDir = mkdtempSync(join(tmpdir(), "kletia-embed-dist-"));
  try {
    const manifest = emitEmbedScript({ distDir, packageRoot });
    assert.equal(manifest.schema, "kletia.embed-manifest/v1");
    assert.equal(manifest.version, "1.2.3");
    const written = JSON.parse(readFileSync(join(distDir, "sdk/embed/manifest.json"), "utf8"));
    assert.deepEqual(written, manifest);
    for (const name of EMBED_FILES) {
      const served = readFileSync(join(distDir, "sdk/embed/1.2.3", name));
      assert.deepEqual(served, readFileSync(join(packageRoot, "dist", name)));
      const expected = `sha384-${createHash("sha384").update(served).digest("base64")}`;
      assert.equal(manifest.files[name].integrity, expected);
      assert.equal(manifest.files[name].path, `/sdk/embed/1.2.3/${name}`);
      assert.equal(manifest.files[name].bytes, served.byteLength);
    }
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
    rmSync(distDir, { recursive: true, force: true });
  }
});

test("a dist built for another version fails instead of shipping under the wrong path", () => {
  const packageRoot = fakePackage("0.2.0", "0.1.0");
  const distDir = mkdtempSync(join(tmpdir(), "kletia-embed-dist-"));
  try {
    assert.throws(() => emitEmbedScript({ distDir, packageRoot }), /built for 0\.1\.0.*says 0\.2\.0/su);
    assert.equal(existsSync(join(distDir, "sdk/embed/manifest.json")), false);
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
    rmSync(distDir, { recursive: true, force: true });
  }
});

test("the development middleware answers the same paths with the same integrity", () => {
  const packageRoot = fakePackage("1.2.3");
  try {
    const manifest = embedDevFile("/sdk/embed/manifest.json", packageRoot);
    assert.equal(manifest.status, 200);
    const parsed = JSON.parse(manifest.body.toString("utf8"));
    const script = embedDevFile("/sdk/embed/1.2.3/kletia-embed.min.js", packageRoot);
    assert.equal(script.status, 200);
    assert.match(script.contentType, /^text\/javascript/u);
    assert.equal(parsed.files["kletia-embed.min.js"].integrity, sriSha384(script.body));
    assert.equal(embedDevFile("/sdk/embed/9.9.9/kletia-embed.min.js", packageRoot).status, 404);
    assert.equal(embedDevFile("/sdk/embed/1.2.3/other.js", packageRoot).status, 404);
    assert.equal(embedDevFile("/developers", packageRoot), null);
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
  }
});

test("one version source: the built @kletia/embed carries packages/embed/package.json's version as EMBED_VERSION", { skip: !existsSync(join(realEmbed, "dist/index.js")) && "packages/embed is not built" }, () => {
  const version = embedVersion(realEmbed);
  assert.equal(version, JSON.parse(readFileSync(join(realEmbed, "package.json"), "utf8")).version);
  const esm = readFileSync(join(realEmbed, "dist/index.js"), "utf8");
  assert.match(esm, new RegExp(`EMBED_VERSION = "${version.replace(/\./gu, "\\.")}"`, "u"));
  const distDir = mkdtempSync(join(tmpdir(), "kletia-embed-dist-"));
  try {
    const manifest = emitEmbedScript({ distDir, packageRoot: realEmbed });
    assert.equal(manifest.version, version);
    assert.equal(manifest.files["kletia-embed.min.js"].integrity, sriSha384(readFileSync(join(realEmbed, "dist/kletia-embed.min.js"))));
  } finally {
    rmSync(distDir, { recursive: true, force: true });
  }
});
