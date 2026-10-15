import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  ARTIFACTS,
  OUTPUT,
  buildExport,
  flattenImmutableReferences,
  maskImmutables,
  serializeExport,
} from "../export-contract-artifacts.mjs";

const root = resolve(import.meta.dirname, "../..");
const script = resolve(root, "tooling/export-contract-artifacts.mjs");

test("masking zeroes exactly the immutable ranges", () => {
  const runtime = `0x${"ff".repeat(10)}`;
  assert.equal(maskImmutables(runtime, [{ start: 2, length: 3 }, { start: 8, length: 1 }]), "0xffff000000ffffff00ff");
  assert.equal(maskImmutables(runtime, []), runtime);
  assert.throws(() => maskImmutables(runtime, [{ start: 9, length: 2 }]), /outside/u);
  assert.deepEqual(flattenImmutableReferences({ 12: [{ start: 40, length: 32 }, { start: 5, length: 32 }], 3: [{ start: 9, length: 20 }] }), [
    { start: 5, length: 32 }, { start: 9, length: 20 }, { start: 40, length: 32 },
  ]);
});

test("the export is deterministic, current and keeps ABI-only entries without bytecode", () => {
  const first = serializeExport(buildExport());
  const second = serializeExport(buildExport());
  assert.equal(first, second);
  assert.equal(readFileSync(OUTPUT, "utf8"), first, "committed file is current");
  const parsed = JSON.parse(first);
  for (const [id, , deployable] of ARTIFACTS) {
    const entry = parsed.artifacts[id];
    assert.equal(entry.deployable, deployable, id);
    if (deployable) {
      assert.match(entry.bytecode, /^0x[0-9a-f]+$/u);
      assert.match(entry.maskedRuntimeHash, /^0x[0-9a-f]{64}$/u);
    } else {
      assert.equal(entry.bytecode, undefined, id);
      assert.equal(entry.deployedBytecode, undefined, id);
      assert.ok(Array.isArray(entry.abi) && entry.abi.length > 0, id);
    }
  }
});

test("--check fails on a mutated file and passes on an exact copy", () => {
  const dir = mkdtempSync(join(tmpdir(), "kletia-artifacts-"));
  const copy = join(dir, "kletia-contracts.json");
  try {
    copyFileSync(OUTPUT, copy);
    assert.equal(spawnSync(process.execPath, [script, "--check", `--output=${copy}`], { cwd: root, encoding: "utf8" }).status, 0);
    writeFileSync(copy, readFileSync(OUTPUT, "utf8").replace("KletiaIntentRouterV2", "KletiaIntentRouterV3"));
    const result = spawnSync(process.execPath, [script, "--check", `--output=${copy}`], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /is stale/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
