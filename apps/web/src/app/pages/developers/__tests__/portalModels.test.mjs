// Pure parts of the developer portal panels (contracts wizard, Rule Book,
// links builder, formatting). Run with Node 22.18 or later, which loads the
// TypeScript sources directly:
//   node --test apps/web/src/app/pages/developers/__tests__/*.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { POLICY_TEMPLATES, validateContractDefinition, validateLinkDefinition, validatePolicy } from "@kletia/core";

import { buildArg, classifyFunctions, guessArg, parseAbiText, sourceOptions } from "../contracts/abi.ts";
import { applyErc4626Hint, buildEvmDefinition, contractStatus, ERC4626_DEPOSIT, evmStepOf, newEntryDraft, suspensionText, wellKnownSnippet } from "../contracts/contractModel.ts";
import { contractCountLine, contractRowModel, contractTabOf, registerVmOf } from "../contracts/contractRows.ts";
import { linkFilterOf, linkRowModel } from "../links/linkRows.ts";
import { acceptOnResume, blinkActionUrl, buildLinkDefinition, cardUrl, templateDraft } from "../links/linkTemplates.ts";
import { formatUsd, httpsUrl, shortId, timeUntil, usageRatio } from "../portal/portalFormat.ts";
import {
  articleOf,
  articleSummary,
  buildKeyTree,
  documentKey,
  fullGrid,
  gridToWindows,
  scheduleToGrid,
  setIn,
  subtreeKeys,
  timetableStatus,
} from "../rulebook/policyModel.ts";

const VAULT = "0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183";
const HUMAN_ABI = `function deposit(uint256 assets, address receiver) returns (uint256 shares)
function approve(address spender, uint256 amount) returns (bool)
function totalAssets() view returns (uint256)
event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)`;

test("a human-readable ABI parses, and forbidden or read-only functions are marked with a reason", () => {
  const parsed = parseAbiText(HUMAN_ABI);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.items.length, 4);
  const functions = classifyFunctions(parsed.items);
  const deposit = functions.find((entry) => entry.signature === "deposit(uint256,address)");
  const approve = functions.find((entry) => entry.signature === "approve(address,uint256)");
  const view = functions.find((entry) => entry.signature === "totalAssets()");
  assert.equal(deposit.allowed, true);
  assert.equal(approve.allowed, false);
  assert.match(approve.reason, /approve/u);
  assert.equal(view.allowed, false);
  assert.match(view.reason, /read-only/u);
  assert.equal(functions[0].allowed, true, "allowed functions are listed first");
});

test("JSON ABIs and build artifacts parse; tuples in human-readable form are refused with a pointer to JSON", () => {
  const artifact = JSON.stringify({ abi: [{ type: "constructor", inputs: [] }, { type: "function", name: "stake", stateMutability: "payable", inputs: [], outputs: [] }] });
  const parsed = parseAbiText(artifact);
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.skipped, 1);
  assert.match(parseAbiText("function f((uint256,address) order)").errors[0], /JSON ABI/u);
  assert.match(parseAbiText("[not json").errors[0], /not valid JSON/u);
  assert.match(parseAbiText("").errors[0], /Paste an ABI/u);
});

test("a beneficiary-named address only binds to the user or the step recipient", () => {
  const receiver = { name: "receiver", type: "address" };
  assert.deepEqual(sourceOptions(receiver).map((option) => option.value), ["$account", "$recipient"]);
  assert.equal(guessArg(receiver).value, "$account");
  const spender = { name: "pool", type: "address" };
  assert.ok(sourceOptions(spender).some((option) => option.value === "$self"));
  assert.equal(guessArg({ name: "assets", type: "uint256" }).value, "$amount");
  assert.deepEqual(buildArg({ mode: "literal", value: "true" }, { name: "flag", type: "bool" }), { binding: { literal: true } });
  assert.ok("issue" in buildArg({ mode: "literal", value: "" }, { name: "x", type: "uint256" }));
});

test("the wizard builds the docs' example, which passes the same checks as the API", () => {
  const parsed = parseAbiText(HUMAN_ABI);
  const fn = parsed.items.find((item) => item.type === "function" && item.name === "deposit");
  const entry = newEntryDraft(fn, parsed.items, guessArg);
  assert.equal(entry.events.length, 1, "an event named like the function is proposed as the proof");
  const draft = {
    network: "base",
    address: VAULT,
    name: "Acme Yield",
    website: "https://acme.example",
    visibility: "private",
    abi: parsed.items,
    addresses: [],
    entries: [{ ...entry, inputToken: "USDC", approval: "$self", outputToken: "$self", events: [{ ...entry.events[0], where: { owner: "$account", assets: "$amount" }, output: "shares" }], aliases: "acme vault", maxAmount: "25000" }],
  };
  const built = buildEvmDefinition(draft, buildArg);
  assert.deepEqual(built.issues, []);
  assert.equal(built.definition.abi.length, 2, "only the chosen function and its event are registered");
  const checked = validateContractDefinition(built.definition);
  assert.equal(checked.ok, true, JSON.stringify(checked.ok ? null : checked.issues));
  assert.equal(evmStepOf("actions[0].events[0].where"), 4);
  assert.equal(evmStepOf("actions[0].args[1]"), 3);
  assert.equal(evmStepOf("integrator.website"), 5);
  assert.equal(evmStepOf("address"), 1);
});

test("contract status lines count down, and suspensions read in plain words", () => {
  const now = Date.parse("2026-10-10T10:00:00Z");
  assert.deepEqual(contractStatus({ status: "pending", activatesAt: "2026-10-10T10:14:30Z", pendingRevision: 1, suspendedReason: null }, now), { label: "Pending", tone: "yellow", detail: "Activates in 14 min 30 s." });
  assert.equal(contractStatus({ status: "suspended", activatesAt: null, pendingRevision: null, suspendedReason: "pins_changed" }, now).detail, "The deployed code changed since it was pinned.");
  assert.equal(suspensionText("operator: abuse"), "Suspended by the operator: abuse.");
  assert.deepEqual(JSON.parse(wellKnownSnippet(["ct_1"], ["lk_1"])), { contracts: ["ct_1"], links: ["lk_1"] });
});

test("rule book drafts change one path at a time, and empty sections disappear", () => {
  let doc = { schema: "kletia.policy/v1" };
  doc = setIn(doc, ["caps", "dailyUsd"], "500");
  assert.deepEqual(doc, { schema: "kletia.policy/v1", caps: { dailyUsd: "500" } });
  doc = setIn(doc, ["caps", "dailyUsd"], undefined);
  assert.deepEqual(doc, { schema: "kletia.policy/v1" });
  assert.equal(documentKey({ schema: "kletia.policy/v1", mode: "live", label: "a" }), documentKey({ label: "a", mode: "live", schema: "kletia.policy/v1" }));
  assert.equal(articleOf("caps.dailyUsd"), 8);
  assert.equal(articleOf("schedule.windows[0].to"), 9);
  assert.equal(articleOf("permissions.links"), 11);
  assert.equal(articleOf("unknownThing"), 0);
});

test("the timetable grid round-trips whole hours and refuses half hours", () => {
  const schedule = { timezone: "UTC", windows: [{ days: ["mon", "tue", "wed", "thu", "fri"], from: "08:00", to: "18:00" }] };
  const grid = scheduleToGrid(schedule);
  assert.equal(grid[0][8], true);
  assert.equal(grid[0][18], false);
  assert.equal(grid[5][9], false);
  assert.deepEqual(gridToWindows(grid), schedule.windows);
  assert.equal(scheduleToGrid({ timezone: "UTC", windows: [{ days: ["mon"], from: "08:30", to: "18:00" }] }), null);
  assert.equal(gridToWindows(fullGrid()).length, 1);
  const valid = validatePolicy({ schema: "kletia.policy/v1", schedule: { timezone: "UTC", windows: gridToWindows(grid) } });
  assert.equal(valid.ok, true);
  assert.match(timetableStatus(schedule, Date.parse("2026-10-10T10:00:00Z")), /^Closed now; opens Monday 08:00 \(UTC\)\.$/u, "a Saturday is closed");
  assert.match(timetableStatus(undefined, Date.now()), /Always open/u);
});

test("article summaries describe templates in plain words", () => {
  const doc = POLICY_TEMPLATES["payments-agent"].document;
  assert.equal(articleSummary(8, doc, "agent"), "$200 a step · $1,000 an intent · $1,000 a day · $5,000 a week");
  assert.equal(articleSummary(7, doc, "agent"), "Own accounts and 0 listed");
  assert.equal(articleSummary(4, { schema: "kletia.policy/v1" }, "agent"), "None (agent default)");
  assert.equal(articleSummary(13, doc, "agent"), "Loosening waits 1 hour");
  assert.equal(articleSummary(10, { schema: "kletia.policy/v1" }, "project"), "Never holds");
});

test("the key tree hangs agents under their parent and lists the cascade of a revocation", () => {
  const keys = [
    { id: "key_a", name: "root", kind: "project", parentId: null, revokedAt: null, current: true },
    { id: "key_b", name: "bot", kind: "agent", parentId: "key_a", revokedAt: null, current: false },
    { id: "key_c", name: "sub", kind: "agent", parentId: "key_b", revokedAt: null, current: false },
    { id: "key_d", name: "gone", kind: "agent", parentId: "key_a", revokedAt: "2026-10-01T00:00:00Z", current: false },
  ];
  const tree = buildKeyTree(keys);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].children.length, 1, "revoked keys are left out");
  assert.deepEqual(subtreeKeys(tree[0].children[0]).map((key) => key.id), ["key_c"]);
  const agentView = buildKeyTree(keys.slice(1, 3));
  assert.equal(agentView[0].key.id, "key_b", "an agent key's own subtree has the agent as its root");
});

test("link templates build definitions core accepts, and card and blink URLs come from validated ids only", () => {
  const draft = { ...templateDraft("get-paid"), publisherName: "Acme Store", website: "https://shop.acme.example", recipient: "0x1111111111111111111111111111111111111111" };
  const definition = buildLinkDefinition(draft);
  const checked = validateLinkDefinition(definition);
  assert.equal(checked.ok, true, JSON.stringify(checked.ok ? null : checked.issues));
  const stake = buildLinkDefinition({ ...templateDraft("bridge-stake"), publisherName: "Stake Club", website: "https://stake.example" });
  assert.equal(validateLinkDefinition(stake).ok, true);
  const id = `lk_${"a1".repeat(12)}`;
  assert.equal(cardUrl("https://api.kletiaai.xyz/", id, "square", 3), `https://api.kletiaai.xyz/v1/links/${id}/card.png?variant=square&v=3`);
  assert.equal(cardUrl("https://api.kletiaai.xyz", "lk_../../keys"), null);
  assert.equal(blinkActionUrl("https://api.kletiaai.xyz", { id, blink: { eligible: true, enabled: true, reason: null } }), `solana-action:https://api.kletiaai.xyz/v1/blinks/${id}`);
  assert.equal(blinkActionUrl("https://api.kletiaai.xyz", { id, blink: { eligible: false, enabled: true, reason: "x" } }), null);
  assert.deepEqual(acceptOnResume("recipient_changed"), ["recipient_changed"]);
  assert.deepEqual(acceptOnResume("operator"), []);
});

test("formatting: https only, dollars, ratios, ids, countdowns", () => {
  assert.equal(httpsUrl("https://acme.example/x"), "https://acme.example/x");
  for (const bad of ["http://acme.example", "javascript:alert(1)", "https://user:pw@acme.example", "data:text/html,x", 42, null]) assert.equal(httpsUrl(bad), null, String(bad));
  assert.equal(formatUsd("2000"), "$2,000");
  assert.equal(formatUsd("1250.5"), "$1,250.50");
  assert.equal(formatUsd(null), "—");
  assert.equal(usageRatio("50", "200"), 0.25);
  assert.equal(usageRatio("500", "200"), 1);
  assert.equal(usageRatio("5", null), null);
  assert.equal(shortId("ct_5f1c2a9b7e3d4c6a8b0e1f23"), "ct_5f1c…1f23");
  assert.deepEqual(timeUntil("2026-10-10T10:01:30Z", Date.parse("2026-10-10T10:00:00Z")), { text: "in 1 min 30 s", past: false, seconds: 90 });
});

const CONTRACT = {
  id: `ct_${"5f".repeat(12)}`,
  vm: "evm",
  network: "base",
  address: VAULT,
  integrator: { name: "Acme Yield", website: "https://acme.example", domainVerified: false },
  status: "active",
  revision: 1,
  activeRevision: 1,
  pendingRevision: null,
  activatesAt: null,
  verification: { source: { status: "exact_match" }, implementationSource: null },
  actions: [{ id: "deposit", label: "Deposit into Acme Prime USDC" }, { id: "withdraw", label: "Withdraw" }],
  suspendedReason: null,
};

test("contract rows: the first entry is the title, tones follow the status table, pending counts down next to UTC", () => {
  const now = Date.parse("2026-10-14T14:40:17Z");
  const active = contractRowModel(CONTRACT, now);
  assert.equal(active.title, "Deposit into Acme Prime USDC", "two registrations of one integrator no longer read the same");
  assert.equal(active.integrator, "Acme Yield");
  assert.equal(active.target, "0xbeeF…8183");
  assert.equal(active.entries, "deposit, withdraw");
  assert.deepEqual([active.status.tone, active.status.label], ["success", "Active"]);
  assert.equal(active.detail, null);
  assert.deepEqual([active.source.tone, active.source.label], ["success", "Source verified"]);
  assert.deepEqual([active.domain.tone, active.domain.label], ["warning", "Domain not verified"], "unverified is a warning, never danger");

  const pending = contractRowModel({ ...CONTRACT, status: "pending", activeRevision: null, activatesAt: "2026-10-14T14:42:00Z" }, now);
  assert.deepEqual([pending.status.tone, pending.status.label], ["info", "Pending"]);
  assert.equal(pending.detail, "activates 14:42 UTC, in 1 min 43 s");
  assert.match(contractRowModel({ ...CONTRACT, pendingRevision: 2, activatesAt: "2026-10-14T15:40:17Z" }, now).detail, /^revision 2 activates 15:40 UTC, in 1 hour$/u);
  const suspended = contractRowModel({ ...CONTRACT, status: "suspended", suspendedReason: "pins_changed" }, now);
  assert.equal(suspended.status.tone, "danger");
  assert.match(suspended.detail, /deployed code changed/u);
  const unknownSource = contractRowModel({ ...CONTRACT, verification: { source: null } }, now);
  assert.equal(unknownSource.source.tone, "warning");
  const svm = contractRowModel({ ...CONTRACT, vm: "svm", network: "solana", address: undefined, origin: "https://actions.acme.example", verification: { programs: [{ program: "P", verified: true }] }, actions: [] }, now);
  assert.equal(svm.target, "actions.acme.example");
  assert.equal(svm.title, "Acme Yield", "no entries: the integrator name");
  assert.equal(svm.source.label, "Programs verified");
});

test("the contracts count line is absent on error and before the first read", () => {
  assert.equal(contractCountLine({ status: "success", data: [CONTRACT, CONTRACT] }), "2 of 25 registrations");
  assert.equal(contractCountLine({ status: "loading", data: [CONTRACT] }), "1 of 25 registrations", "a reload keeps the last count");
  assert.equal(contractCountLine({ status: "error", data: [CONTRACT] }), null, "never above an error");
  assert.equal(contractCountLine({ status: "error", data: undefined }), null);
  assert.equal(contractCountLine({ status: "loading", data: undefined }), null);
  assert.equal(contractTabOf(new URLSearchParams("tab=pins")), "pins");
  assert.equal(contractTabOf(new URLSearchParams("tab=nope")), "overview");
  assert.equal(registerVmOf(new URLSearchParams("vm=svm")), "svm");
  assert.equal(registerVmOf(new URLSearchParams("vm=other")), "evm");
});

test("the wizard prefills an ERC-4626 deposit from the inspection hint, and nothing else", () => {
  const parsed = parseAbiText(HUMAN_ABI);
  const fn = parsed.items.find((item) => item.type === "function" && item.name === "deposit");
  const plain = newEntryDraft(fn, parsed.items, guessArg);
  assert.equal(plain.signature, ERC4626_DEPOSIT);
  const filled = applyErc4626Hint(plain, { asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", registrySymbol: "USDC" }, parsed.items, "Acme");
  assert.equal(filled.inputToken, "USDC");
  assert.equal(filled.approval, "$self");
  assert.equal(filled.outputToken, "$self");
  assert.equal(filled.label, "Deposit into Acme USDC vault");
  assert.equal(filled.verbs, "deposit");
  assert.equal(filled.aliases, "acme vault");
  assert.deepEqual(filled.events, [{ event: "Deposit(address,address,uint256,uint256)", emitter: "$self", where: { sender: "", owner: "$account", assets: "$amount", shares: "" }, output: "shares" }]);
  assert.equal(filled.maxAmount, "", "limits stay a decision");
  // Not a registry asset here: the input stays empty for the developer to decide.
  assert.equal(applyErc4626Hint(plain, { asset: "0x1111111111111111111111111111111111111111", registrySymbol: null }, parsed.items).inputToken, "");
  // No hint, or another function: unchanged.
  assert.equal(applyErc4626Hint(plain, undefined, parsed.items), plain);
  const view = parsed.items.find((item) => item.type === "function" && item.name === "totalAssets");
  const other = newEntryDraft(view, parsed.items, guessArg);
  assert.equal(applyErc4626Hint(other, { asset: VAULT, registrySymbol: "USDC" }, parsed.items), other);

  // The prefilled entry builds a definition the API's own checks accept.
  const built = buildEvmDefinition(
    { network: "base", address: VAULT, name: "Acme", website: "https://acme.example", visibility: "private", abi: parsed.items, addresses: [], entries: [{ ...filled, maxAmount: "25000" }] },
    buildArg,
  );
  assert.deepEqual(built.issues, []);
  const checked = validateContractDefinition(built.definition);
  assert.equal(checked.ok, true, JSON.stringify(checked.ok ? null : checked.issues));
});

const LINK = {
  id: `lk_${"a1".repeat(12)}`,
  status: "active",
  title: "Deposit USDC into Acme Vault",
  publisher: { name: "Acme Yield", domainVerified: false },
  funding: { networks: ["base", "arbitrum"] },
  destination: { network: "base" },
  activatesAt: null,
  expiresAt: "2026-11-14T00:00:00Z",
  uses: { max: null, left: null },
  pausedReason: null,
  suspendedReason: null,
  stats: { pageView: 1234, intent: 7, volumeUsd: "250" },
};

test("link rows: unverified is a warning, withdrawn is neutral, counters show a dash when unread", () => {
  const now = Date.parse("2026-10-14T13:53:00Z");
  const row = linkRowModel(LINK, now);
  assert.deepEqual([row.status.tone, row.status.label], ["success", "Active"]);
  assert.deepEqual([row.publisherStatus.tone, row.publisherStatus.label], ["warning", "Unverified"]);
  assert.deepEqual(row.from, ["base", "arbitrum"]);
  assert.equal(row.to, "base");
  assert.equal(row.views, "1,234");
  assert.equal(row.intents, "7");
  assert.equal(row.completed, "0", "a counter missing from a read report is zero");
  assert.equal(row.volume, "$250");
  const withdrawn = linkRowModel({ ...LINK, status: "deleted", stats: undefined }, now);
  assert.deepEqual([withdrawn.status.tone, withdrawn.status.label], ["neutral", "Withdrawn"]);
  assert.deepEqual([withdrawn.views, withdrawn.intents, withdrawn.volume], ["–", "–", "–"], "never a zero the page did not read");
  assert.equal(linkRowModel({ ...LINK, publisher: { name: "A", domainVerified: true } }, now).publisherStatus.tone, "success");
  const pending = linkRowModel({ ...LINK, status: "pending", activatesAt: "2026-10-14T14:05:00Z" }, now);
  assert.equal(pending.status.tone, "info");
  assert.equal(pending.detail, "activates 14:05 UTC, in 12 min");
  const paused = linkRowModel({ ...LINK, status: "paused", pausedReason: "contract_changed" }, now);
  assert.deepEqual([paused.status.tone, paused.detail], ["warning", "a pinned contract has a newer revision"]);
  assert.equal(linkFilterOf(new URLSearchParams("status=paused")), "paused");
  assert.equal(linkFilterOf(new URLSearchParams("status=<x>")), "");
});
