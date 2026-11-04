// THE NETWORK: the /network routes, the family data, the live Lykia parsing and
// loading, the departure board rows and the art engine. Run with
//   node --test apps/web/src/app/pages/network/__tests__/network.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { matchRoute, ROUTES } from "../../../routes/routeTable.ts";
import { PRIMARY_NAV } from "../../../site/siteLinks.ts";
import { contrastRatio } from "../../../site/art/color.ts";
import {
  DEPARTURES,
  ELYIA_PUBLIC,
  FLAP_INFO_WIDTH,
  FLAP_LINE_WIDTH,
  FLAP_STATUS_WIDTH,
  familyBoard,
  LINE_DETAILS,
  LINEAGE,
  LINES,
  LYKIA_CONTRACTS,
  lykiaFigures,
  MAP_STOPS,
  parseLykiaHealth,
  parseLykiaStats,
  shortAddress,
  TRANSFERS,
} from "../networkData.ts";
import { fromRelay, isFresh, LYKIA_CACHE_MS, LYKIA_FAILURE_CACHE_MS, LYKIA_RELAY_PATH, loadLykia, resetLykiaCache } from "../lykiaLive.ts";
import {
  ELY_CLIMB,
  ELY_PALETTE,
  ELYIA_H,
  ELYIA_W,
  elyiaScene,
  LYKIA_H,
  LYKIA_W,
  lykiaScene,
  LYKO_PALETTE,
  LYKO_TROT,
  ridgeTop,
  spriteColours,
  TRAIL,
  trailPoint,
} from "../pixelArt.ts";

const sitemap = readFileSync(new URL("../../../../../public/sitemap.xml", import.meta.url), "utf8");

const STATS = {
  environment: "mainnet",
  onchain: { contracts: LYKIA_CONTRACTS.map(({ name, address }) => ({ name, address })), accountsCreated: 1 },
  routed: { intents: 0 },
  ecosystem: { protocols: 94, verified: 42, routable: 9 },
  at: "2026-11-04T20:37:43.614Z",
};
const HEALTH = { status: "ok", version: "0.1.0", environment: "mainnet", networks: { "arc-mainnet": { reachable: true, head: 29555550, latencyMs: 40 } } };

test("/network and the two line pages are indexed site routes with fixed paths", () => {
  for (const [path, id] of [
    ["/network", "network"],
    ["/network/elyia", "networkElyia"],
    ["/network/lykia", "networkLykia"],
  ]) {
    const route = matchRoute(path);
    assert.equal(route.id, id, path);
    assert.equal(route.kind, "site");
    assert.equal(route.path, path);
    assert.equal(route.robots, undefined);
    assert.equal(route.canonicalFromPath, undefined, "a fixed path: write-route-pages writes its HTML");
    assert.ok(route.title.length <= 70, route.title);
    assert.ok(route.description.length >= 50 && route.description.length <= 200, `${path}: ${route.description.length}`);
    assert.equal(ROUTES[id], route);
    assert.ok(sitemap.includes(`<loc>https://kletiaai.xyz${path}</loc>`), `${path} in the sitemap`);
  }
  assert.equal(matchRoute("/network/other").id, "notFound");
  assert.equal(matchRoute("/networks").id, "networks", "the status board keeps its own route");
  assert.ok(PRIMARY_NAV.some((item) => item.label === "Network" && item.to === "/network"));
});

test("lines: the Interchange and two departures, each with a readable bullet", () => {
  assert.deepEqual(DEPARTURES.map((line) => line.id), ["elyia", "lykia"]);
  assert.equal(LINES.kletia.line, "The Interchange");
  assert.equal(LINES.elyia.line, "Summit Line");
  assert.equal(LINES.lykia.line, "Coast Line");
  for (const line of Object.values(LINES)) {
    assert.ok(contrastRatio(line.color, line.on) >= 4.5, `${line.code} bullet contrast`);
    assert.match(line.code, /^[A-Z]{3}$/u);
    for (const link of line.links) assert.match(link.href, /^(\/|https:\/\/)/u);
  }
  assert.deepEqual(LINES.elyia.networks, ["HyperCore", "HyperEVM", "Elysium"]);
  assert.deepEqual(LINES.lykia.networks, ["Arc mainnet"]);
  assert.ok(LINES.kletia.networks.includes("Solana") && LINES.kletia.networks.includes("Base"));
  assert.ok(!LINES.kletia.networks.some((name) => /testnet|devnet|sepolia/iu.test(name)), "production networks only");
});

test("Elyia links nowhere while its repository is not public", () => {
  assert.equal(ELYIA_PUBLIC, false);
  assert.deepEqual(LINES.elyia.links, []);
  assert.match(LINES.elyia.status, /in development/iu);
  assert.ok(LINES.lykia.links.some((link) => link.href === "https://github.com/furkan3152/Lykia"));
});

test("the lineage runs Kletia, then Elyia, then Lykia, and the map has a stop for each line", () => {
  assert.deepEqual(LINEAGE.map((step) => [step.from, step.to]), [["kletia", "elyia"], ["elyia", "lykia"]]);
  for (const id of ["kletia", "elyia", "lykia"]) assert.ok(MAP_STOPS.some((stop) => stop.line === id), id);
  assert.equal(MAP_STOPS.filter((stop) => stop.terminus).length, 2);
  assert.equal(new Set(MAP_STOPS.map((stop) => stop.id)).size, MAP_STOPS.length);
});

test("transfer stations map policies to the Rule Book and the Fence, and asks to Ely and Lyko", () => {
  const byId = Object.fromEntries(TRANSFERS.map((station) => [station.id, station]));
  assert.deepEqual([byId.policy.kletia, byId.policy.elyia, byId.policy.lykia], ["Rule Book", "Rule Book", "The Fence"]);
  assert.deepEqual([byId.ask.elyia, byId.ask.lykia], ["Ask Ely", "Ask Lyko"]);
  assert.ok(byId.platform);
  for (const station of TRANSFERS) for (const key of ["concept", "kletia", "elyia", "lykia", "note"]) assert.ok(station[key], `${station.id}.${key}`);
  for (const detail of Object.values(LINE_DETAILS)) assert.ok(detail.does.length >= 3 && detail.shares.length > 40);
});

test("Lykia's answers are parsed defensively: wrong types become null, never a number", () => {
  const stats = parseLykiaStats(STATS);
  assert.deepEqual(
    { a: stats.accountsCreated, p: stats.protocols, v: stats.verified, r: stats.routable, c: stats.contracts },
    { a: 1, p: 94, v: 42, r: 9, c: 3 },
  );
  const health = parseLykiaHealth(HEALTH);
  assert.deepEqual({ s: health.status, h: health.arcHead, l: health.arcLatencyMs, r: health.arcReachable }, { s: "ok", h: 29555550, l: 40, r: true });
  assert.equal(parseLykiaStats(null), null);
  assert.equal(parseLykiaStats([1]), null);
  const odd = parseLykiaStats({ ecosystem: { protocols: "94", verified: -1, routable: Number.NaN } });
  assert.deepEqual([odd.protocols, odd.verified, odd.routable], [null, null, null]);
  assert.equal(parseLykiaHealth({ status: "fine" }).status, null);
  assert.equal(shortAddress(LYKIA_CONTRACTS[0].address), "0x810e…d7f9");
  assert.equal(shortAddress("nope"), "nope");
});

test("board rows: Lykia checking, live, delayed, suspended and offline; Elyia always building", () => {
  const live = (health) => ({ state: "live", stats: parseLykiaStats(STATS), health: parseLykiaHealth(health), at: 0 });
  const kletia = { state: "live", ok: 9, total: 9 };
  const statusOf = (lykia) => familyBoard(kletia, lykia)[2];
  assert.equal(statusOf({ state: "loading", stats: null, health: null, at: null }).tone, "checking");
  const running = statusOf(live(HEALTH));
  assert.equal(running.tone, "running");
  assert.equal(running.flapInfo, "40 MS");
  assert.match(running.spoken, /40 milliseconds/u);
  assert.equal(statusOf(live({ ...HEALTH, status: "degraded" })).tone, "delayed");
  assert.equal(statusOf(live({ ...HEALTH, networks: { "arc-mainnet": { reachable: false } } })).tone, "suspended");
  const offline = statusOf({ state: "offline", stats: null, health: null, at: 1 });
  assert.equal(offline.tone, "unknown");
  assert.equal(offline.flapStatus, "NO SIGNAL");
  const rows = familyBoard({ state: "live", ok: 8, total: 9 }, { state: "offline", stats: null, health: null, at: 1 });
  assert.equal(rows[0].flapStatus, "DELAYED");
  assert.equal(rows[1].tone, "building");
  for (const row of rows) {
    assert.ok(row.flapLine.length <= FLAP_LINE_WIDTH, row.flapLine);
    assert.ok(row.flapInfo.length <= FLAP_INFO_WIDTH, row.flapInfo);
    assert.ok(row.flapStatus.length <= FLAP_STATUS_WIDTH, row.flapStatus);
    assert.ok(row.spoken.length > 20);
  }
  assert.equal(familyBoard({ state: "loading" }, { state: "loading", stats: null, health: null, at: null })[0].flapStatus, "CHECKING");
});

test("figures print a dash for anything missing", () => {
  const empty = lykiaFigures({ state: "offline", stats: null, health: null, at: 1 });
  assert.ok(empty.every((figure) => figure.value === "—"));
  const full = lykiaFigures({ state: "live", stats: parseLykiaStats(STATS), health: parseLykiaHealth(HEALTH), at: 1 });
  assert.equal(full.find((figure) => figure.label === "Arc block").value, "29,555,550");
  assert.equal(full.find((figure) => figure.label === "Arc RPC").value, "40 ms");
});

test("loading: the relay first, /v1/stats directly as a fallback, one cache for every caller", async () => {
  const relayBody = { success: true, stats: STATS, health: HEALTH };
  assert.deepEqual(fromRelay(relayBody).health?.arcHead, 29555550);
  assert.deepEqual(fromRelay(null), { stats: null, health: null });

  resetLykiaCache();
  const calls = [];
  const ok = (body) => ({ ok: true, json: async () => body });
  let clock = 1000;
  const fetcher = async (url) => {
    calls.push(url);
    if (url.endsWith(LYKIA_RELAY_PATH)) return ok(relayBody);
    throw new Error("unexpected");
  };
  const first = await loadLykia({ fetcher, now: () => clock, relayOrigin: "https://api.kletiaai.xyz/" });
  assert.equal(first.state, "live");
  assert.equal(first.health.arcLatencyMs, 40);
  assert.deepEqual(calls, ["https://api.kletiaai.xyz/api/network/lykia"]);
  clock += LYKIA_CACHE_MS - 1;
  await loadLykia({ fetcher, now: () => clock, relayOrigin: "https://api.kletiaai.xyz" });
  assert.equal(calls.length, 1, "served from the cache");

  resetLykiaCache();
  const fallbackCalls = [];
  const fallback = await loadLykia({
    now: () => clock,
    relayOrigin: "https://api.kletiaai.xyz",
    fetcher: async (url) => {
      fallbackCalls.push(url);
      if (url.endsWith("/v1/stats")) return ok(STATS);
      return { ok: false, json: async () => ({}) };
    },
  });
  assert.equal(fallback.state, "live");
  assert.equal(fallback.health, null, "no Arc reading without the relay");
  assert.equal(fallback.stats.protocols, 94);
  assert.equal(fallbackCalls.length, 2);

  resetLykiaCache();
  const down = await loadLykia({ now: () => clock, relayOrigin: null, fetcher: async () => Promise.reject(new Error("offline")) });
  assert.equal(down.state, "offline");
  assert.ok(isFresh(down, clock + LYKIA_FAILURE_CACHE_MS - 1));
  assert.ok(!isFresh(down, clock + LYKIA_FAILURE_CACHE_MS));
  resetLykiaCache();
});

test("art: sprites use only their palettes, scenes keep their size, the trail stays on the mountain", () => {
  for (const frame of ELY_CLIMB) for (const key of spriteColours(frame)) assert.ok(ELY_PALETTE[key], `Ely colour ${key}`);
  for (const frame of LYKO_TROT) for (const key of spriteColours(frame)) assert.ok(LYKO_PALETTE[key], `Lyko colour ${key}`);
  for (const t of [0, 0.5, 2, 7.3, 30]) {
    const elyia = elyiaScene(t);
    assert.equal(elyia.length, ELYIA_H);
    assert.ok(elyia.every((row) => row.length === ELYIA_W));
    const lykia = lykiaScene(t);
    assert.equal(lykia.length, LYKIA_H);
    assert.ok(lykia.every((row) => row.length === LYKIA_W));
  }
  for (const [x, y] of TRAIL) assert.ok(y >= ridgeTop(x), `trail point ${x},${y} is on the rock`);
  assert.deepEqual(trailPoint(0), { x: TRAIL[0][0], y: TRAIL[0][1], dir: 1 });
  const top = trailPoint(1);
  assert.deepEqual([top.x, top.y], TRAIL[TRAIL.length - 1]);
  // Deterministic: the same time paints the same picture; the still frame is complete.
  assert.deepEqual(elyiaScene(4.2), elyiaScene(4.2));
  assert.deepEqual(lykiaScene(0, true), lykiaScene(99, true));
  const still = elyiaScene(0, true).flat();
  assert.ok(still.includes("#B98552"), "Ely is drawn in the still frame");
  assert.ok(lykiaScene(0, true).flat().includes(LYKO_PALETTE.f), "Lyko is drawn in the still frame");
  // A negative clock (rAF can run a hair behind) never breaks a frame.
  assert.equal(elyiaScene(-0.01).length, ELYIA_H);
  assert.equal(lykiaScene(-0.01).length, LYKIA_H);
});
