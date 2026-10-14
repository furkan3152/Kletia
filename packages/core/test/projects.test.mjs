/**
 * Project settings: validation, merge patches, the canonical hash and the
 * domain file.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  PROJECT_LIMITS,
  PROJECT_SCHEMA,
  flowNetworks,
  mergePatch,
  mergeProjectPatch,
  normalizeProjectOrigin,
  projectDomainFile,
  projectSettingsHash,
  validateProjectSettings,
} from "../dist/index.js";

const flow = {
  id: "deposit",
  label: "Deposit into Acme vault",
  actions: [{ kind: "bridge", network: "arbitrum-sepolia", toNetwork: "base", from: "USDC", amount: "5" }],
};

const paths = (result) => (result.ok ? [] : result.issues.map((issue) => issue.path));

test("valid settings come back normalised", () => {
  const result = validateProjectSettings({
    schema: PROJECT_SCHEMA,
    brand: { name: "Acme Store", website: "https://Acme.Example/" },
    allowedOrigins: ["https://acme.example", "https://acme.example/", "http://localhost:3000", "https://staging.acme.example:8443"],
    defaults: { lane: "production", networks: ["base", "ethereum"], sourceNetwork: "base", actions: ["swap", "bridge"], examples: ["swap 10 USDC to ETH on Base"], appearance: { light: { accent: "#ff6600" } } },
  });
  assert.ok(result.ok, JSON.stringify(result.issues));
  assert.equal(result.value.brand.website, "https://acme.example");
  assert.deepEqual(result.value.allowedOrigins, ["https://acme.example", "http://localhost:3000", "https://staging.acme.example:8443"]);
  assert.equal(result.value.defaults.appearance.light.accent, "#FF6600");
});

test("origins: https or http://localhost:<port>, at most 20", () => {
  assert.equal(normalizeProjectOrigin("http://localhost:5173"), "http://localhost:5173");
  assert.equal(normalizeProjectOrigin("http://acme.example"), null);
  assert.equal(normalizeProjectOrigin("http://127.0.0.1:3000"), null);
  assert.equal(normalizeProjectOrigin("https://acme.example/path"), null);
  assert.equal(normalizeProjectOrigin("https://10.0.0.1"), null);
  assert.deepEqual(paths(validateProjectSettings({ schema: PROJECT_SCHEMA, allowedOrigins: ["http://acme.example"] })), ["allowedOrigins[0]"]);
  const many = Array.from({ length: PROJECT_LIMITS.allowedOrigins + 1 }, (_, index) => `https://s${index}.acme.example`);
  assert.deepEqual(paths(validateProjectSettings({ schema: PROJECT_SCHEMA, allowedOrigins: many })), ["allowedOrigins"]);
});

test("brand names follow the integrator rules; reserved brands need their own host", () => {
  assert.deepEqual(paths(validateProjectSettings({ schema: PROJECT_SCHEMA, brand: { name: "x" } })), ["brand.name"]);
  assert.deepEqual(paths(validateProjectSettings({ schema: PROJECT_SCHEMA, brand: { name: "Uniswap", website: "https://acme.example" } })), ["brand.name"]);
  assert.deepEqual(paths(validateProjectSettings({ schema: PROJECT_SCHEMA, brand: { name: "Kletia Pay" } })), ["brand.name"]);
  assert.deepEqual(paths(validateProjectSettings({ schema: PROJECT_SCHEMA, brand: { name: "Acme", website: "http://acme.example" } })), ["brand.website"]);
  assert.ok(validateProjectSettings({ schema: PROJECT_SCHEMA, brand: { name: "Uniswap", website: "https://app.uniswap.org" } }).ok);
});

test("brand.website takes the default https port only (a proof on another port proves nothing about the host)", () => {
  for (const website of ["https://acme.example:8443", "https://acme.example:1024", "https://acme.example:65535"]) {
    assert.deepEqual(paths(validateProjectSettings({ schema: PROJECT_SCHEMA, brand: { name: "Acme", website } })), ["brand.website"], website);
  }
  const explicit = validateProjectSettings({ schema: PROJECT_SCHEMA, brand: { name: "Acme", website: "https://acme.example:443" } });
  assert.ok(explicit.ok);
  assert.equal(explicit.value.brand.website, "https://acme.example");
});

test("defaults: lane, networks, sourceNetwork (or auto), actions, examples, appearance", () => {
  const issues = (defaults) => paths(validateProjectSettings({ schema: PROJECT_SCHEMA, defaults }));
  assert.deepEqual(issues({ lane: "mainnet" }), ["defaults.lane"]);
  assert.deepEqual(issues({ lane: "testnet", networks: ["base"] }), ["defaults.networks[0]"]);
  assert.deepEqual(issues({ networks: ["base"], sourceNetwork: "ethereum" }), ["defaults.sourceNetwork"]);
  assert.ok(validateProjectSettings({ schema: PROJECT_SCHEMA, defaults: { sourceNetwork: "auto" } }).ok);
  assert.deepEqual(issues({ actions: ["lend"] }), ["defaults.actions[0]"]);
  assert.deepEqual(issues({ examples: ["x".repeat(121)] }), ["defaults.examples[0]"]);
  assert.deepEqual(issues({ examples: Array(7).fill("swap") }), ["defaults.examples"]);
  assert.deepEqual(issues({ appearance: { light: { accent: "red" } } }), ["defaults.appearance.light.accent"]);
  assert.deepEqual(issues({ colour: "red" }), ["defaults.colour"]);
});

test("flows are validated like sessions, with unique ids and at most 20", () => {
  assert.ok(validateProjectSettings({ schema: PROJECT_SCHEMA, flows: [flow] }).ok);
  assert.deepEqual(paths(validateProjectSettings({ schema: PROJECT_SCHEMA, flows: [flow, flow] })), ["flows[1].id"]);
  assert.deepEqual(paths(validateProjectSettings({ schema: PROJECT_SCHEMA, flows: [{ ...flow, id: "Deposit" }] })), ["flows[0].id"]);
  assert.deepEqual(paths(validateProjectSettings({ schema: PROJECT_SCHEMA, flows: [{ ...flow, label: "" }] })), ["flows[0].label"]);
  assert.ok(paths(validateProjectSettings({ schema: PROJECT_SCHEMA, flows: [{ ...flow, actions: [] }] }))[0].startsWith("flows[0].actions"));
  assert.deepEqual(paths(validateProjectSettings({ schema: PROJECT_SCHEMA, flows: [{ ...flow, amount: { action: 0, min: "10", max: "1" } }] })), ["flows[0].amount.min"]);
  const many = Array.from({ length: PROJECT_LIMITS.flows + 1 }, (_, index) => ({ ...flow, id: `f${index}` }));
  assert.deepEqual(paths(validateProjectSettings({ schema: PROJECT_SCHEMA, flows: many })), ["flows"]);
  // The GET view carries ownerKeyId on flows: sending it back is accepted and dropped.
  const echoed = validateProjectSettings({ schema: PROJECT_SCHEMA, flows: [{ ...flow, ownerKeyId: "key_0" }] });
  assert.ok(echoed.ok);
  assert.equal(echoed.value.flows[0].ownerKeyId, undefined);
  assert.deepEqual(flowNetworks(flow), ["arbitrum-sepolia", "base"]);
});

test("merge patches: null removes, objects merge, arrays replace, the schema is implied", () => {
  const current = { schema: PROJECT_SCHEMA, allowedOrigins: ["https://a.example"], defaults: { lane: "testnet", examples: ["a"] } };
  const merged = mergeProjectPatch(current, { allowedOrigins: ["https://b.example"], defaults: { examples: null, actions: ["swap"] } });
  assert.ok(merged.ok);
  assert.deepEqual(merged.value, { schema: PROJECT_SCHEMA, allowedOrigins: ["https://b.example"], defaults: { lane: "testnet", actions: ["swap"] } });
  assert.ok(mergeProjectPatch(null, { brand: { name: "Acme" } }).ok);
  assert.deepEqual(paths(mergeProjectPatch(current, { schema: "kletia.project/v2" })), ["schema"]);
  assert.equal(mergeProjectPatch(current, ["x"]).ok, false);
  assert.deepEqual(mergePatch({ a: 1 }, { ["__proto__"]: { polluted: true } }), { a: 1 });
  assert.equal({}.polluted, undefined);
});

test("the hash is canonical and the domain file lists the project", () => {
  const a = projectSettingsHash({ schema: PROJECT_SCHEMA, allowedOrigins: ["https://a.example"], brand: { name: "Acme" } });
  const b = projectSettingsHash({ brand: { name: "Acme" }, allowedOrigins: ["https://a.example"], schema: PROJECT_SCHEMA });
  assert.equal(a, b);
  assert.match(a, /^sha256:[0-9a-f]{64}$/u);
  assert.notEqual(a, projectSettingsHash({ schema: PROJECT_SCHEMA }));
  assert.deepEqual(JSON.parse(projectDomainFile("prj_key_1")), { projects: ["prj_key_1"] });
});
