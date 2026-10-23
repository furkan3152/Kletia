// Desk copy as data: every string the desk prints, templates included,
// is plain English with no emoji and no em dash. The starter sentences
// and the tool catalogue follow the same rules.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DESK_COPY } from "../content/copy.ts";
import { STARTER_CAPABILITIES, STARTERS, rephraseStarter, startersFor } from "../content/starters.ts";
import { LEGACY_FEATURES, TOOLS } from "../tools/catalogue.ts";
import { DESK_MORE_COPY } from "../shell/deskCopy.ts";

const here = dirname(fileURLToPath(import.meta.url));
const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/u;
/** Printable ASCII plus the middle dot and the ellipsis the art direction uses. */
const PLAIN = /^[\x20-\x7E·…]*$/u;

/** Every string leaf, rendering templates with sample arguments. */
function strings(value, path = "DESK_COPY") {
  if (typeof value === "string") return [[path, value]];
  if (typeof value === "function") {
    const args = Array.from({ length: value.length }, (_, index) => (index % 2 === 0 ? "Base" : "3"));
    const rendered = value(...args);
    assert.equal(typeof rendered, "string", `${path} renders a string`);
    return [[`${path}()`, rendered]];
  }
  if (value && typeof value === "object") return Object.entries(value).flatMap(([key, entry]) => strings(entry, `${path}.${key}`));
  return [];
}

function assertPlain(path, text) {
  assert.ok(text.length > 0, `${path} is not empty`);
  assert.ok(!EMOJI.test(text), `${path} has no emoji: ${text}`);
  assert.ok(!text.includes("—"), `${path} has no em dash: ${text}`);
  assert.ok(PLAIN.test(text), `${path} is plain English text: ${text}`);
  assert.equal(text, text.trim(), `${path} has no outer spaces`);
  assert.ok(!/ {2}/u.test(text), `${path} has no double spaces`);
}

test("every desk string and template is plain English, with no emoji and no em dash", () => {
  const all = strings(DESK_COPY);
  assert.ok(all.length > 150, `the desk copy is complete (${all.length} strings)`);
  for (const [path, text] of all) assertPlain(path, text);
  assert.ok(Object.isFrozen(DESK_COPY.ticket.lines), "copy is read-only data");
});

test("the desk's added strings follow the same rules", () => {
  const all = strings(DESK_MORE_COPY, "DESK_MORE_COPY");
  assert.ok(all.length >= 8);
  for (const [path, text] of all) assertPlain(path, text);
  assert.ok(Object.isFrozen(DESK_MORE_COPY.wallets), "read-only data");
  // Label in name (WCAG 2.5.3): the short pill text is contained in the accessible name.
  assert.ok(DESK_COPY.wallets.connectEvm.startsWith(DESK_MORE_COPY.wallets.connectEvmShort));
  assert.ok(DESK_COPY.wallets.connectSolana.startsWith(DESK_MORE_COPY.wallets.connectSolanaShort));
});

test("the fixed copy is there, word for word", () => {
  assert.equal(DESK_COPY.page.title, "Kletia Console");
  assert.equal(DESK_COPY.empty.heading, "Where should the money go?");
  assert.equal(DESK_COPY.composer.errors.secret, "Private keys, seed phrases and API keys never go into Kletia. Nothing was sent or saved.");
  assert.equal(DESK_COPY.tasks.signingLocked, "Another task is signing. Finish or stop it first.");
  assert.equal(DESK_COPY.departure.disabledNoService, "No service: the network's RPC is not answering.");
  assert.equal(DESK_COPY.departure.disabledNotOffered, "Not available on this deployment.");
  assert.equal(DESK_COPY.engine.wrongChain("OP Mainnet", "Base"), "Your EVM wallet is on OP Mainnet. This task signs on Base.");
  assert.equal(
    DESK_COPY.ticket.lines.text("Base", "Arbitrum"),
    'Departs Base · your sentence names it, so the departure Arbitrum was not used. To start from Arbitrum, add "from Arbitrum" to the sentence.',
  );
  assert.equal(DESK_COPY.tasks.announcements.question("Swap SOL to USDC"), "Kletia has a question about Swap SOL to USDC");
  assert.equal(DESK_COPY.source.question("25", "USDC"), "Where should the 25 USDC come from?");
  assert.equal(DESK_COPY.wallets.evmConnected("Rabby", "0x4f18…807D"), "EVM wallet Rabby 0x4f18…807D, open account options");
});

test("starter sentences, capability labels and tool texts follow the same rules", () => {
  for (const capability of STARTER_CAPABILITIES) assertPlain(`capability ${capability.id}`, capability.label);
  for (const starter of STARTERS) assertPlain(`starter ${starter.id}`, starter.sentence);
  for (const tool of TOOLS) {
    assertPlain(`tool ${tool.id} title`, tool.title);
    assertPlain(`tool ${tool.id} summary`, tool.summary);
    for (const prompt of tool.prompts ?? []) {
      assertPlain(`tool ${tool.id} prompt ${prompt.id} label`, prompt.label);
      assertPlain(`tool ${tool.id} prompt ${prompt.id}`, prompt.sentence);
    }
  }
  for (const feature of LEGACY_FEATURES) assertPlain(`feature ${feature.id}`, feature.title);
});

test("the desk's content and state sources carry no em dash and no emoji, in code or copy", () => {
  for (const directory of ["../content", "../state", "../tools", "../shell", "../composer", "../tasks", "../holdings", "../activity", "../dashboard", "../hooks", "."]) {
    for (const file of readdirSync(resolve(here, directory === "." ? ".." : directory)).filter((name) => /\.(tsx?|css)$/u.test(name))) {
      const source = readFileSync(join(resolve(here, directory === "." ? ".." : directory), file), "utf8");
      assert.ok(!source.includes("—"), `${directory}/${file} has no em dash`);
      assert.ok(!EMOJI.test(source), `${directory}/${file} has no emoji`);
    }
  }
});

test("starters are filtered by what the deployment offers and re-phrased from the departure", () => {
  const featured = startersFor({ featuredOnly: true });
  assert.deepEqual(featured.map((starter) => starter.capability), ["bridge", "swap", "lend", "send", "stake", "test"], "Try one: one per capability");
  assert.equal(featured.find((starter) => starter.capability === "test").sentence, "send 1 USDC to <address> on arc");
  const fromBase = startersFor({ departure: "base", featuredOnly: true }).map((starter) => starter.sentence);
  assert.ok(fromBase.includes("deposit 100 USDC into aave on base"), "re-phrased from the departure");
  assert.ok(fromBase.includes("bridge 25 USDC from base to solana"));
  assert.ok(!fromBase.some((sentence) => sentence.includes("<address> on arc")), "no test yard sentence from a production departure");
  const yard = startersFor({ departure: "arbitrum-sepolia" });
  assert.ok(yard.every((starter) => starter.capability === "test"), "a testnet departure shows the test yard only");
  assert.equal(yard[0].sentence, "send 0.001 ETH to <address> on arbitrum sepolia");
  // Live capabilities decide: today only Solana, Base and Arbitrum swap; Ethereum has no stake yet.
  const actions = {
    base: ["swap", "transfer", "bridge", "deposit", "withdraw"],
    arbitrum: ["swap", "transfer", "bridge", "deposit", "withdraw"],
    ethereum: ["transfer", "bridge", "deposit", "withdraw"],
    optimism: ["transfer", "bridge", "deposit", "withdraw"],
    polygon: ["transfer", "bridge", "deposit", "withdraw"],
    solana: ["swap", "transfer", "bridge", "stake", "deposit", "withdraw"],
    arc: ["transfer"],
  };
  assert.equal(rephraseStarter("swap", "polygon", actions), null, "Polygon has no swap in v1 (and POL is its native asset)");
  assert.equal(rephraseStarter("swap", "ethereum", actions), null);
  assert.equal(rephraseStarter("swap", "ethereum", { ...actions, ethereum: [...actions.ethereum, "swap"] }).sentence, "swap 0.01 ETH for USDC on ethereum");
  assert.ok(!startersFor({ actions }).some((starter) => starter.id === "stake-lido"), "Lido waits for the API");
  assert.ok(!startersFor({ actions }).some((starter) => starter.networks.includes("arbitrum-sepolia")), "a network the API does not list is never offered");
  assert.equal(rephraseStarter("lend", "solana", actions).sentence, "deposit 10 USDC into jupiter lend");
  assert.equal(rephraseStarter("stake", "base", actions), null);
});

test("the tools say 'a Solana wallet' and 'an EVM wallet'", () => {
  assert.equal(DESK_COPY.tools.needsOn(DESK_COPY.tools.needs.solana, "Solana"), "Needs a Solana wallet on Solana");
  assert.equal(DESK_COPY.tools.needsOn(DESK_COPY.tools.needs.evm, "Base"), "Needs an EVM wallet on Base");
});
