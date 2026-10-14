// The desk's tool catalogue: every legacy console feature has a home,
// every tool network is a registry key, every console-only protocol is
// reachable from the desk, and only the Base engine's starters reach
// Kletia Intent Router V2.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { getProtocol, NETWORK_KEYS, PROTOCOLS } from "@kletia/core";

import { LEGACY_NETWORKS } from "../state/deskModel.ts";
import { CONSOLE_PROTOCOL_HOMES, getTool, LEGACY_FEATURES, toolPath, TOOLS } from "../tools/catalogue.ts";

const here = dirname(fileURLToPath(import.meta.url));
const toolsDir = resolve(here, "../tools");
const KINDS = new Set(["panel", "form", "read-only", "prompt", "link"]);
const CATEGORIES = new Set(["pay", "earn", "swap", "send", "names", "security", "data", "funding", "contracts", "agents"]);
const SURFACES = new Set(["composer", "departure", "wallets", "tasks", "holdings", "activity", "header"]);
/** The four protocols only the network engines execute (protocols.ts before `execution` existed). */
const CONSOLE_ONLY = ["kletia-router-v2", "basenames", "arc-native", "circle-app-kit"];

test("every legacy console feature has at least one home, and every tool home exists", () => {
  const ids = new Set();
  for (const feature of LEGACY_FEATURES) {
    assert.ok(!ids.has(feature.id), `duplicate feature ${feature.id}`);
    ids.add(feature.id);
    assert.ok(feature.homes.length > 0, `${feature.id} has a home`);
    for (const home of feature.homes) {
      if (home.kind === "tool") assert.ok(getTool(home.toolId), `${feature.id}: tool ${home.toolId} exists`);
      if (home.kind === "desk") assert.ok(SURFACES.has(home.surface), `${feature.id}: surface ${home.surface}`);
      if (home.kind === "engine-task") assert.ok(home.network === "any" || LEGACY_NETWORKS.includes(home.network), `${feature.id}: engine ${home.network}`);
      if (home.kind === "removed") assert.ok(home.reason.length > 10, `${feature.id}: removal is explained`);
    }
  }
  // Every feature of the old console, so none is lost on the way.
  for (const id of ["evm-chat", "network-switcher", "webacy", "allora", "basename-claim", "airdrop-simulator", "x402-console", "fund-wallet", "arc-dashboard", "arc-lending", "arc-faucet", "circle-app-kit", "arbitrum-prompts", "portfolio-drawer", "activity-drawer", "solana-overview", "solana-ask", "solana-swap", "solana-send", "solana-stake", "solana-yields", "workflow-resume", "ai-consent", "token-clarification", "studio-execution"]) {
    assert.ok(ids.has(id), `legacy feature ${id} is listed`);
  }
  // Every tool is somebody's home (no orphan tool).
  const homed = new Set(LEGACY_FEATURES.flatMap((feature) => feature.homes.filter((home) => home.kind === "tool").map((home) => home.toolId)));
  for (const tool of TOOLS) assert.ok(homed.has(tool.id), `${tool.id} replaces a legacy feature`);
});

test("every tool is well formed: unique id and number, registry networks, a kind, a category and something to open", () => {
  assert.equal(TOOLS.length, 17);
  assert.deepEqual(TOOLS.map((tool) => tool.number), Array.from({ length: 17 }, (_, index) => index + 1));
  assert.equal(new Set(TOOLS.map((tool) => tool.id)).size, TOOLS.length);
  for (const tool of TOOLS) {
    for (const network of tool.networks) assert.ok(NETWORK_KEYS.includes(network), `${tool.id}: ${network} is a registry key`);
    assert.ok(KINDS.has(tool.kind), `${tool.id}: kind ${tool.kind}`);
    assert.ok(CATEGORIES.has(tool.category), `${tool.id}: category ${tool.category}`);
    assert.ok(["evm", "solana", "none"].includes(tool.needs), `${tool.id}: needs`);
    assert.ok(tool.engine === null || LEGACY_NETWORKS.includes(tool.engine), `${tool.id}: engine`);
    if (tool.engine) assert.ok(tool.networks.includes(tool.engine), `${tool.id}: its engine is one of its networks`);
    assert.ok(tool.summary.length > 0 && tool.summary.length <= 140, `${tool.id}: one line`);
    for (const protocol of tool.protocols) assert.ok(getProtocol(protocol), `${tool.id}: protocol ${protocol} is in the registry`);
    if (tool.kind === "link") {
      assert.ok(typeof tool.href === "string" && (tool.href.startsWith("https://") || tool.href.startsWith("/")), `${tool.id}: link target`);
      assert.equal(tool.load, undefined);
    } else if (tool.kind === "prompt") {
      assert.ok(tool.prompts?.length || tool.load, `${tool.id}: prompts or a panel`);
      assert.ok(tool.engine, `${tool.id}: a prompt tool pins an engine`);
    } else {
      assert.equal(typeof tool.load, "function", `${tool.id}: lazy panel`);
      assert.ok(tool.exportName, `${tool.id}: named export`);
    }
  }
  assert.equal(toolPath("arc-contracts"), "/app/tools/arc-contracts");
});

test("every lazy tool points at an existing component that exports the named component", () => {
  for (const tool of TOOLS.filter((entry) => entry.load)) {
    const specifier = /import\("([^"]+)"\)/u.exec(tool.load.toString())?.[1];
    assert.ok(specifier, `${tool.id}: dynamic import`);
    const file = `${join(toolsDir, specifier)}.tsx`;
    assert.ok(existsSync(file), `${tool.id}: ${file} exists`);
    const source = readFileSync(file, "utf8");
    assert.match(source, new RegExp(`export (?:const|function) ${tool.exportName}\\b`, "u"), `${tool.id}: exports ${tool.exportName}`);
  }
});

test("every console-only protocol has a tool or an engine route; only the Base starters reach Intent Router V2", () => {
  const consoleOnly = PROTOCOLS.some((protocol) => "execution" in protocol)
    ? PROTOCOLS.filter((protocol) => protocol.execution === "console").map((protocol) => protocol.id)
    : CONSOLE_ONLY;
  for (const id of CONSOLE_ONLY) assert.ok(consoleOnly.includes(id), `${id} is console-only`);
  for (const id of consoleOnly) {
    const home = CONSOLE_PROTOCOL_HOMES[id];
    assert.ok(home, `${id} has a desk home`);
    assert.ok(LEGACY_NETWORKS.includes(home.engine), `${id}: engine ${home.engine}`);
    assert.ok(getProtocol(id).networks.includes(home.engine), `${id} runs on the ${home.engine} engine's network`);
    for (const toolId of home.toolIds) {
      const tool = getTool(toolId);
      assert.ok(tool, `${id}: tool ${toolId}`);
      assert.equal(tool.engine, home.engine, `${toolId} pins the ${home.engine} engine`);
    }
  }
  assert.deepEqual(TOOLS.filter((tool) => tool.protocols.includes("kletia-router-v2")).map((tool) => tool.id), ["base-engine-starters"]);
  assert.deepEqual(CONSOLE_PROTOCOL_HOMES["kletia-router-v2"].toolIds, ["base-engine-starters"]);
});

test("the engine starter tools carry today's sidebar prompts, so none is lost when the sidebar goes", () => {
  const source = readFileSync(resolve(here, "../../../shared/config/networks.ts"), "utf8");
  const sidebar = [...source.matchAll(/prompt:\s*(?:"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`)/gu)]
    .map((match) => (match[1] ?? match[2]).replace(/\$\{ACTIVE_WALLET_ADDRESS\}/gu, "{{ACTIVE_WALLET_ADDRESS}}").replace(/\\"/gu, '"'));
  const starters = new Set(TOOLS.flatMap((tool) => (tool.prompts ?? []).map((prompt) => prompt.sentence)));
  // The sidebar is deleted with the old console; until then every one of its prompts has a starter.
  for (const prompt of sidebar) assert.ok(starters.has(prompt), `sidebar prompt has a home: ${prompt.slice(0, 60)}`);
  if (sidebar.length > 0) assert.equal(sidebar.length, 14);
  const placeholder = TOOLS.flatMap((tool) => tool.prompts ?? []).filter((prompt) => prompt.sentence.includes("{{ACTIVE_WALLET_ADDRESS}}"));
  assert.deepEqual(placeholder.map((prompt) => prompt.id), ["arc-batch", "arc-memo"]);
});
