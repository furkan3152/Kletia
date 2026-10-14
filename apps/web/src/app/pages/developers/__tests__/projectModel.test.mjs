// Project page model (integrator design 4.8, Phase 2 portal): the merge patch
// a draft sends, inline origin checks, the domain proof states, the diff
// after a stale If-Match, network chips by lane, publishable-key warnings,
// flows built from a registration, the test session and the logo pre-check.
//   node --test apps/web/src/app/pages/developers/__tests__/projectModel.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { mergeProjectPatch } from "@kletia/core";

import {
  appearanceIssue,
  buildFlow,
  changedFields,
  checkLogoBytes,
  checkOrigin,
  domainStatus,
  draftFromSettings,
  draftPatch,
  EMPTY_FLOW_DRAFT,
  fieldOfPath,
  flowDraftOf,
  flowSources,
  flowSummary,
  flowsWith,
  flowsWithout,
  mergeDiff,
  networksByLane,
  rebaseDraft,
  offeredNetworks,
  publishableWarnings,
  settingsDiff,
  suggestFlowId,
  testSessionRequest,
  toggleNetwork,
  withLane,
} from "../project/projectModel.ts";

const PROJECT = "prj_key_2dce0f6a";
const SETTINGS = {
  schema: "kletia.project/v1",
  brand: { name: "Acme Store", website: "https://acme.example" },
  allowedOrigins: ["https://acme.example", "http://localhost:3000"],
  defaults: { lane: "production", networks: ["base", "arbitrum", "solana"], sourceNetwork: "base", actions: ["swap", "bridge"], appearance: { light: { accent: "#0E7C66" }, radius: 10 } },
  flows: [
    {
      id: "deposit",
      label: "Deposit into Acme vault",
      actions: [{ kind: "call", network: "arbitrum-sepolia", contract: "ct_10a2b3c4d5e6f7a8091a2b3c", entry: "supply", amount: "10" }],
      amount: { action: 0, min: "1", max: "100" },
      ownerKeyId: "key_saver",
    },
  ],
};

test("an unchanged draft sends an empty patch; edits send only what changed, removals as null", () => {
  const draft = draftFromSettings(SETTINGS);
  const same = draftPatch(SETTINGS, draft);
  assert.equal(same.ok, true);
  assert.deepEqual(same.patch, {});
  assert.deepEqual(changedFields(SETTINGS, draft), []);

  const edited = { ...draft, brandName: "Acme Shop", origins: ["https://acme.example"], sourceNetwork: "" };
  const result = draftPatch(SETTINGS, edited);
  assert.equal(result.ok, true);
  assert.deepEqual(result.patch, { brand: { name: "Acme Shop" }, allowedOrigins: ["https://acme.example"], defaults: { sourceNetwork: null } });
  assert.deepEqual(changedFields(SETTINGS, edited).sort(), ["brandName", "origins", "sourceNetwork"]);
  // The patch never carries flows: they save on their own (and are dry-run by the API).
  assert.equal("flows" in result.patch, false);
  // Applied by the API's own merge, it yields the draft.
  const merged = mergeProjectPatch(SETTINGS, result.patch);
  assert.equal(merged.ok, true);
  assert.equal(merged.value.brand.name, "Acme Shop");
  assert.equal(merged.value.defaults.sourceNetwork, undefined);
  assert.equal(merged.value.flows.length, 1);
});

test("replacing the appearance removes the tokens the new JSON leaves out (merge patches merge objects)", () => {
  const draft = { ...draftFromSettings(SETTINGS), appearance: JSON.stringify({ radius: 4 }) };
  const result = draftPatch(SETTINGS, draft);
  assert.equal(result.ok, true);
  assert.deepEqual(result.patch, { defaults: { appearance: { light: null, radius: 4 } } });
  assert.deepEqual(mergeProjectPatch(SETTINGS, result.patch).value.defaults.appearance, { radius: 4 });
  assert.deepEqual(mergeDiff({ a: { b: 1, c: 2 } }, { a: { b: 1 } }), { a: { c: null } });
});

test("draft problems map to their fields: invalid JSON, a website without a name, a network off the lane", () => {
  const base = draftFromSettings(SETTINGS);
  const json = draftPatch(SETTINGS, { ...base, appearance: "{ nope" });
  assert.equal(json.ok, false);
  assert.equal(json.issues[0].field, "appearance");
  const unnamed = draftPatch(SETTINGS, { ...base, brandName: "" });
  assert.equal(unnamed.ok, false);
  assert.equal(unnamed.issues[0].field, "brandName");
  const offLane = draftPatch(SETTINGS, { ...base, networks: ["base", "arc"], sourceNetwork: "base" });
  assert.equal(offLane.ok, false);
  assert.equal(offLane.issues[0].field, "networks");
  assert.equal(fieldOfPath("allowedOrigins[3]"), "origins");
  assert.equal(fieldOfPath("defaults.light.accent"), "appearance");
  assert.equal(fieldOfPath("brand.website"), "website");
  assert.equal(fieldOfPath("flows[0].actions[0].contract"), "flows");
  assert.equal(appearanceIssue(""), null);
  assert.equal(appearanceIssue('{"radius":4}'), null);
  assert.match(appearanceIssue('{"radius":"big"}'), /radius/u);
});

test("origins are checked inline: https or localhost only, no path, no duplicate, at most 20", () => {
  assert.deepEqual(checkOrigin(" https://Shop.Acme.example/ ", []), { ok: true, origin: "https://shop.acme.example" });
  assert.deepEqual(checkOrigin("http://localhost:5173", []), { ok: true, origin: "http://localhost:5173" });
  assert.match(checkOrigin("http://acme.example", []).message, /Use https/u);
  assert.match(checkOrigin("https://acme.example/checkout", []).message, /no path/u);
  assert.match(checkOrigin("https://acme.example", ["https://acme.example"]).message, /already allowed/u);
  assert.match(checkOrigin("https://10.0.0.1", []).message, /public host/u);
  assert.match(checkOrigin("", []).message, /Type an origin/u);
  const full = Array.from({ length: 20 }, (_, index) => `https://o${index}.example`);
  assert.match(checkOrigin("https://more.example", full).message, /at most 20/u);
});

test("domain proof: no website, unchecked, verified, and a failed check with the file it looked for (warning, never danger)", () => {
  const file = JSON.stringify({ projects: [PROJECT] });
  const view = (brand, domain) => ({ id: PROJECT, settings: { brand }, domain: { host: null, verified: false, checkedAt: null, file, ...domain } });
  const none = domainStatus(view(undefined, {}));
  assert.equal(none.state, "none");
  assert.equal(none.fileUrl, null);
  const unchecked = domainStatus(view(SETTINGS.brand, { host: "acme.example" }));
  assert.equal(unchecked.state, "unchecked");
  assert.equal(unchecked.fileUrl, "https://acme.example/.well-known/kletia.json");
  assert.equal(unchecked.status.tone, "warning");
  const failed = domainStatus(view(SETTINGS.brand, { host: "acme.example", checkedAt: "2026-10-14T12:00:00.000Z" }), () => "14 Oct 2026, 12:00 UTC");
  assert.equal(failed.state, "failed");
  assert.equal(failed.status.tone, "warning");
  assert.match(failed.message, /14 Oct 2026, 12:00 UTC did not find prj_key_2dce0f6a in https:\/\/acme\.example\/\.well-known\/kletia\.json/u);
  const verified = domainStatus(view(SETTINGS.brand, { host: "acme.example", verified: true, checkedAt: "2026-10-14T12:00:00.000Z" }));
  assert.equal(verified.state, "verified");
  assert.equal(verified.status.tone, "success");
  assert.equal(verified.file, file);
});

test("the diff after a stale If-Match lists each changed field, flows by id without their saver", () => {
  const theirs = {
    ...SETTINGS,
    brand: { name: "Acme Store", website: "https://shop.acme.example" },
    defaults: { ...SETTINGS.defaults, networks: ["base"] },
    flows: [{ ...SETTINGS.flows[0], ownerKeyId: "key_other" }, { id: "swap", label: "Swap", actions: [{ kind: "swap", network: "base", from: "USDC", to: "ETH", amount: "5" }], ownerKeyId: "key_other" }],
  };
  const diff = settingsDiff(SETTINGS, theirs);
  assert.deepEqual(
    diff.map((change) => change.path),
    ["brand.website", "defaults.networks", "flows.swap"],
  );
  assert.equal(diff[0].before, "https://acme.example");
  assert.equal(diff[0].after, "https://shop.acme.example");
  assert.equal(diff[1].after, "base");
  assert.equal(diff[2].before, "(not set)");
  assert.deepEqual(settingsDiff(SETTINGS, SETTINGS), []);
});

test("network chips: nine networks by lane; picking a lane drops the others and an orphaned start network", () => {
  const groups = networksByLane();
  assert.deepEqual(groups.map((group) => group.networks.length), [6, 3]);
  assert.equal(groups.flatMap((group) => group.networks).length, 9);
  const draft = { ...draftFromSettings(SETTINGS), lane: "", networks: ["base", "arc"], sourceNetwork: "arc" };
  const live = withLane(draft, "production");
  assert.deepEqual(live.networks, ["base"]);
  assert.equal(live.sourceNetwork, "");
  const auto = withLane({ ...draft, sourceNetwork: "auto" }, "testnet");
  assert.deepEqual(auto.networks, ["arc"]);
  assert.equal(auto.sourceNetwork, "auto");
  const off = toggleNetwork({ ...draftFromSettings(SETTINGS) }, "base");
  assert.deepEqual(off.networks, ["arbitrum", "solana"]);
  assert.equal(off.sourceNetwork, "", "removing the start network resets Start on");
  assert.deepEqual(toggleNetwork(off, "ethereum").networks, ["arbitrum", "ethereum", "solana"], "chips keep the registry order");
});

test("publishable keys: a rule book that refuses an offered network or a flow's network is a warning", () => {
  assert.deepEqual(offeredNetworks({ schema: "kletia.project/v1", defaults: { lane: "testnet" } }), ["arc", "arbitrum-sepolia", "solana-devnet"]);
  assert.equal(offeredNetworks(undefined).length, 9);
  const keyLevel = { networks: { allow: ["base", "arbitrum"] } };
  const warnings = publishableWarnings(SETTINGS, [null, keyLevel]);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /offers Solana but this key's rule book refuses it \(networks\.allow\)/u);
  assert.match(warnings[1], /Flow deposit runs on Arbitrum Sepolia/u);
  const lanes = publishableWarnings({ ...SETTINGS, flows: [] }, [{ networks: { lanes: ["testnet"] } }]);
  assert.equal(lanes.length, 3);
  assert.match(lanes[0], /networks\.lanes/u);
  assert.deepEqual(publishableWarnings({ ...SETTINGS, flows: [] }, [{ networks: { allow: ["base", "arbitrum", "solana"], lanes: ["production"] } }]), []);
});

const VAULT = {
  id: "ct_10a2b3c4d5e6f7a8091a2b3c",
  vm: "evm",
  network: "arbitrum-sepolia",
  status: "active",
  integrator: { name: "Acme" },
  actions: [{ id: "supply", label: "Supply USDC" }],
};

test("a flow from a registration: one call step, visitor amount bounds, unique ids, API-shaped issues", () => {
  assert.deepEqual(flowSources([VAULT, { ...VAULT, id: "ct_x", status: "suspended" }, { ...VAULT, id: "ct_y", actions: [] }]).map((item) => item.id), [VAULT.id]);
  assert.equal(suggestFlowId("supply", []), "supply");
  assert.equal(suggestFlowId("supply", ["supply"]), "supply-2");
  assert.equal(suggestFlowId("2Deposit_All", []), "deposit-all");
  const draft = { ...EMPTY_FLOW_DRAFT, id: "deposit", label: "Deposit into Acme vault", contract: VAULT.id, entry: "supply", amount: "10", visitorAmount: true, min: "1", max: "100" };
  const built = buildFlow(draft, VAULT, []);
  assert.equal(built.ok, true);
  assert.deepEqual(built.flow.actions, [{ kind: "call", network: "arbitrum-sepolia", contract: VAULT.id, entry: "supply", amount: "10" }]);
  assert.deepEqual(built.flow.amount, { action: 0, min: "1", max: "100" });
  assert.equal(buildFlow({ ...draft, vm: "svm" }, { ...VAULT, vm: "svm", network: "solana-devnet" }, []).flow.actions[0].kind, "action");

  const taken = buildFlow(draft, VAULT, [{ id: "deposit" }]);
  assert.equal(taken.ok, false);
  assert.equal(taken.issues[0].field, "id");
  assert.equal(buildFlow(draft, VAULT, [{ id: "deposit" }], "deposit").ok, true, "an edited flow keeps its id");
  const outside = buildFlow({ ...draft, amount: "500" }, VAULT, []);
  assert.equal(outside.ok, false);
  assert.equal(outside.issues[0].field, "amount");
  const badId = buildFlow({ ...draft, id: "Deposit!" }, VAULT, []);
  assert.equal(badId.issues[0].field, "id");
  assert.equal(buildFlow(draft, null, []).issues[0].field, "contract");
  assert.equal(buildFlow({ ...draft, entry: "withdraw" }, VAULT, []).issues[0].field, "entry");
});

test("flows round-trip through the editor, and lists drop the saver before a patch", () => {
  const stored = SETTINGS.flows[0];
  const draft = flowDraftOf(stored);
  assert.deepEqual(draft, { id: "deposit", label: "Deposit into Acme vault", contract: VAULT.id, entry: "supply", amount: "10", visitorAmount: true, min: "1", max: "100" });
  assert.equal(flowDraftOf({ id: "swap", label: "Swap", actions: [{ kind: "swap", network: "base" }] }), null);
  assert.equal(flowSummary(stored), "Arbitrum Sepolia · ct_10a2b3… supply · visitor picks 1-100");
  const replaced = flowsWith(SETTINGS.flows, { ...stored, label: "New label", ownerKeyId: undefined }, "deposit");
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0].label, "New label");
  assert.equal("ownerKeyId" in flowsWith(SETTINGS.flows, { id: "b", label: "B", actions: stored.actions }, null)[0], false);
  assert.deepEqual(flowsWithout(SETTINGS.flows, "deposit"), []);
});

test("Test opens a single-use 10 minute session for this page's origin only", () => {
  const request = testSessionRequest(SETTINGS.flows[0], "http://localhost:3820");
  assert.deepEqual(request.allowedOrigins, ["http://localhost:3820"]);
  assert.equal(request.maxIntents, 1);
  assert.equal(request.expiresInSeconds, 600);
  assert.deepEqual(request.amount, { action: 0, min: "1", max: "100" });
  assert.equal(request.metadata.flow, "deposit");
  assert.equal("ownerKeyId" in request, false);
});

function chunkPng(type, data) {
  const out = new Uint8Array(12 + data.length);
  new DataView(out.buffer).setUint32(0, data.length);
  out.set([...type].map((c) => c.charCodeAt(0)), 4);
  out.set(data, 8);
  return out;
}
function png(width, height, extra = []) {
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, width);
  new DataView(ihdr.buffer).setUint32(4, height);
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunkPng("IHDR", ihdr), ...extra, chunkPng("IEND", new Uint8Array())];
  return Uint8Array.from(parts.flatMap((part) => [...part]));
}
function webp(chunks) {
  const body = chunks.flatMap(([type, data]) => {
    const head = new Uint8Array(8);
    head.set([...type].map((c) => c.charCodeAt(0)), 0);
    new DataView(head.buffer).setUint32(4, data.length, true);
    return [...head, ...data, ...(data.length % 2 ? [0] : [])];
  });
  const out = new Uint8Array(12 + body.length);
  out.set([..."RIFF"].map((c) => c.charCodeAt(0)), 0);
  new DataView(out.buffer).setUint32(4, 4 + body.length, true);
  out.set([..."WEBP"].map((c) => c.charCodeAt(0)), 8);
  out.set(body, 12);
  return out;
}
function vp8l(width, height) {
  const data = new Uint8Array(10);
  data[0] = 0x2f;
  new DataView(data.buffer).setUint32(1, ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), true);
  return data;
}

test("the logo pre-check reads PNG and WebP headers and refuses SVG, GIF, animation, oversize and odd shapes", () => {
  assert.deepEqual(checkLogoBytes(png(256, 64)), { ok: true, contentType: "image/png", width: 256, height: 64 });
  assert.deepEqual(checkLogoBytes(webp([["VP8L", vp8l(128, 128)]])), { ok: true, contentType: "image/webp", width: 128, height: 128 });
  assert.match(checkLogoBytes(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')).message, /PNG or WebP/u);
  assert.match(checkLogoBytes(new TextEncoder().encode("GIF89a........")).message, /PNG or WebP/u);
  assert.match(checkLogoBytes(png(256, 64, [chunkPng("acTL", new Uint8Array(8))])).message, /Animated PNG/u);
  const vp8x = new Uint8Array(10);
  vp8x[0] = 0x02;
  assert.match(checkLogoBytes(webp([["VP8X", vp8x]])).message, /Animated WebP/u);
  assert.match(checkLogoBytes(webp([["VP8L", vp8l(128, 128)], ["ANIM", new Uint8Array(6)]])).message, /Animated WebP/u);
  assert.match(checkLogoBytes(png(600, 200)).message, /32-512 px/u);
  assert.match(checkLogoBytes(png(64, 128)).message, /1 to 4 times/u);
  assert.match(checkLogoBytes(png(512, 100)).message, /1 to 4 times/u);
  assert.match(checkLogoBytes(new Uint8Array(70_000)).message, /limit is 64 KB/u);
  assert.match(checkLogoBytes(new Uint8Array()).message, /empty/u);
});

test("keeping my edits after a conflict keeps only the fields I changed; theirs win everywhere else", () => {
  const theirs = { ...SETTINGS, allowedOrigins: [...SETTINGS.allowedOrigins, "https://staging.acme.example"] };
  const mine = { ...draftFromSettings(SETTINGS), brandName: "Acme Shop" };
  const rebased = rebaseDraft(SETTINGS, theirs, mine);
  assert.equal(rebased.brandName, "Acme Shop");
  assert.deepEqual(rebased.origins, theirs.allowedOrigins, "their new origin survives");
  const result = draftPatch(theirs, rebased);
  assert.deepEqual(result.patch, { brand: { name: "Acme Shop" } });
});
