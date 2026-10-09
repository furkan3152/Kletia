// Pure tests for the Interchange art system (src/app/site/art). Run with Node
// 22.18 or later, which loads the TypeScript sources directly:
//   node --test apps/web/src/app/site/art/__tests__/*.test.mjs
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CHAINS, NETWORK_KEYS, PROTOCOLS } from "@kletia/core";

import {
  boardName,
  boardStatus,
  describeLatency,
  DRUM,
  flipsBetween,
  formatBoardClock,
  formatLatency,
  LATENCY_WIDTH,
  padFlaps,
  riffleDuration,
  riffleFrame,
  STATUS_FLAPS,
  STATUS_SPEECH,
  STATUS_WIDTH,
} from "../boardFormat.ts";
import { contrastRatio, parseHex, readableOn, relativeLuminance } from "../color.ts";
import { DOWN_RIGHT, isOctilinear, rounded, tick, UP } from "../geometry.ts";
import { categoryIcon, categoryWord, ICON_NAMES, ICON_PLATES, ICON_STROKES, isIconName } from "../icons.ts";
import {
  INTERCHANGE,
  joinNames,
  KLETIA_PLATE,
  labelPlacement,
  MAPPED_NETWORKS,
  mapDescription,
  signLayout,
  TRACKS,
  TRIP_POINTS,
  yardLayout,
} from "../routeMapLayout.ts";
import { STAMP_LABELS, STAMP_SENTENCES, STAMP_STATES } from "../stampText.ts";
import { countOf, legNumber, punchCount, shortHash } from "../ticketFormat.ts";
import { INTERCHANGE_VENUES, lineFor, LINES, PRODUCTION_LINES, venueOn, YARD_LINES } from "../tokens.ts";

const artDir = join(dirname(fileURLToPath(import.meta.url)), "..");

/* ---- geometry ------------------------------------------------------------------ */

test("rounded() draws straight segments and quadratic bends", () => {
  assert.equal(rounded([[0, 0], [100, 0]]), "M0 0L100 0");
  assert.equal(
    rounded([[0, 0], [100, 0], [100, 100]]),
    "M0 0L82 0Q100 0 100 18L100 100",
    "a right-angle bend starts and ends 18 units from the corner",
  );
  assert.equal(rounded([[0, 0], [100, 0], [100, 100]], 10), "M0 0L90 0Q100 0 100 10L100 100");
  assert.equal(
    rounded([[0, 0], [20, 0], [20, 20]], 18),
    "M0 0L10 0Q20 0 20 10L20 20",
    "the radius never exceeds half of either segment",
  );
  assert.equal(rounded([[0, 0], [40, 40], [80, 40]], 18), "M0 0L27.3 27.3Q40 40 58 40L80 40", "45 degree bends round to one decimal");
  assert.throws(() => rounded([[0, 0]]), /at least two points/u);
  assert.throws(() => rounded([[0, 0], [0, 0], [10, 0]]), /zero-length/u);
});

test("tick() and isOctilinear()", () => {
  assert.equal(tick([10, 10], UP, 0, 15), "M10 10L10 -5");
  assert.equal(tick([0, 0], DOWN_RIGHT, 0, 10), "M0 0L7.1 7.1");
  assert.equal(isOctilinear([[0, 0], [10, 0], [20, 10], [20, 30]]), true);
  assert.equal(isOctilinear([[0, 0], [10, 3]]), false);
});

/* ---- departure board ----------------------------------------------------------- */

test("formatLatency() always fits six tiles", () => {
  const cases = [
    [null, "--- MS"],
    [undefined, "--- MS"],
    [Number.NaN, "--- MS"],
    [-5, "--- MS"],
    [0, "0 MS"],
    [96.4, "96 MS"],
    [212, "212 MS"],
    [999.4, "999 MS"],
    [999.6, "1.00 S"],
    [1840, "1.84 S"],
    [9994, "9.99 S"],
    [9996, "10.0 S"],
    [12_345, "12.3 S"],
    [99_949, "99.9 S"],
    [99_950, "99+ S"],
    [3_600_000, "99+ S"],
  ];
  for (const [ms, text] of cases) assert.equal(formatLatency(ms), text, `formatLatency(${ms})`);
  for (let ms = 0; ms < 200_000; ms += 7.3) assert.ok(formatLatency(ms).length <= LATENCY_WIDTH, `${ms} fits`);
});

test("describeLatency() reads naturally", () => {
  assert.equal(describeLatency(96), "96 milliseconds");
  assert.equal(describeLatency(1840), "1.84 seconds");
  assert.equal(describeLatency(null), "no reading");
});

test("padFlaps(), boardName() and the status words", () => {
  assert.equal(padFlaps("Base", 6), "BASE  ");
  assert.equal(padFlaps("Arbitrum Sepolia", 13), "ARBITRUM SEPO");
  assert.equal(boardName({ name: "Arbitrum Sepolia", shortName: "Arb Sepolia" }), "Arb Sepolia", "long names use the short name");
  assert.equal(boardName({ name: "Base", shortName: "Base" }), "Base");
  for (const line of [...PRODUCTION_LINES, ...YARD_LINES]) assert.ok(boardName(line).length <= 13, `${line.name} fits the board`);
  for (const [status, text] of Object.entries(STATUS_FLAPS)) {
    assert.ok(text.length <= STATUS_WIDTH, `${status} fits ${STATUS_WIDTH} tiles`);
    assert.ok([...text].every((char) => DRUM.includes(char)), `${status} is on the drum`);
    assert.ok(STATUS_SPEECH[status], `${status} has words`);
  }
});

test("boardStatus() maps health readings", () => {
  assert.equal(boardStatus(undefined), "unknown");
  assert.equal(boardStatus(undefined, { loading: true }), "checking");
  assert.equal(boardStatus({ ok: null }), "unknown");
  assert.equal(boardStatus({ ok: false, latencyMs: 20 }), "suspended");
  assert.equal(boardStatus({ ok: true, latencyMs: 96 }), "running");
  assert.equal(boardStatus({ ok: true, latencyMs: 1840 }), "delayed");
  assert.equal(boardStatus({ ok: true, latencyMs: 1840 }, { delayedAboveMs: 2000 }), "running");
  assert.equal(boardStatus({ ok: true }), "running");
});

test("formatBoardClock() prints UTC hours and minutes", () => {
  assert.equal(formatBoardClock(new Date(Date.UTC(2026, 9, 9, 7, 5))), "07:05 UTC");
});

test("riffleFrame() turns changed tiles forward through the drum and lands on the target", () => {
  const from = padFlaps("", 6);
  const to = padFlaps("96 ms", 6);
  const first = riffleFrame(from, to, 0);
  assert.equal(first.done, false);
  assert.equal(first.text.length, 6);
  const end = riffleDuration(from, to);
  assert.ok(end > 0 && end < 1200, `a six-tile riffle takes under 1.2 s (${end} ms)`);
  const last = riffleFrame(from, to, end);
  assert.equal(last.done, true);
  assert.equal(last.text, to);
  assert.ok(last.turning.every((flag) => !flag));
  assert.equal(riffleFrame(from, to, end - 1).done, false, "riffleDuration is the first finished frame");
  for (let t = 0; t <= end; t += 16) {
    const frame = riffleFrame(from, to, t);
    assert.equal(frame.text.length, to.length);
    assert.ok([...frame.text].every((char) => DRUM.includes(char)), "every frame shows drum characters");
  }

  const same = riffleFrame("BASE  ", "BASE  ", 0);
  assert.equal(same.done, true, "nothing changes, nothing turns");
  assert.equal(same.text, "BASE  ");

  const partial = riffleFrame("212 MS", "214 MS", 0);
  assert.deepEqual(partial.turning, [false, false, false, false, false, false]);
  for (let t = 0; t < 600; t += 16) {
    const frame = riffleFrame("212 MS", "214 MS", t);
    assert.equal(frame.text.slice(0, 2) + frame.text.slice(3), "21 MS", "unchanged tiles never move");
  }
  assert.equal(flipsBetween("A", "A"), 0);
  assert.equal(flipsBetween("A", "B"), 1);
  assert.equal(flipsBetween(" ", "9"), 12, "long turns are capped");
  assert.equal(flipsBetween("·", "A"), 1, "characters off the drum switch in one flap");
});

/* ---- colour and tokens ---------------------------------------------------------- */

test("colour maths matches WCAG", () => {
  assert.deepEqual(parseHex("#fff"), [255, 255, 255]);
  assert.equal(parseHex("blue"), null);
  assert.equal(relativeLuminance("#000000"), 0);
  assert.equal(relativeLuminance("#FFFFFF"), 1);
  assert.equal(Math.round(contrastRatio("#000", "#fff")), 21);
  assert.equal(readableOn("#0052FF"), "#FFFFFF");
  assert.equal(readableOn("#14F195"), "#0B1120");
});

test("every registry network is a line, read from the registry", () => {
  assert.deepEqual(Object.keys(LINES).sort(), [...NETWORK_KEYS].sort());
  const codes = new Set();
  for (const key of NETWORK_KEYS) {
    const line = LINES[key];
    const chain = CHAINS[key];
    assert.equal(line.name, chain.name);
    assert.equal(line.color, chain.color);
    assert.equal(line.id, chain.id);
    assert.equal(line.lane, chain.lane);
    assert.equal(line.yard, chain.lane === "testnet");
    assert.equal(line.gauge, chain.vm === "svm" ? "svm" : "standard");
    assert.match(line.code, /^[A-Z0-9]{2,4}$/u);
    assert.ok(!codes.has(line.code), `bullet code ${line.code} is unique`);
    codes.add(line.code);
    assert.ok(contrastRatio(line.color, line.on) >= 4.5, `${line.name} bullet text is AA (${contrastRatio(line.color, line.on).toFixed(2)})`);
  }
  assert.equal(PRODUCTION_LINES.length + YARD_LINES.length, NETWORK_KEYS.length);
  assert.ok(PRODUCTION_LINES.every((line) => !line.yard) && YARD_LINES.every((line) => line.yard));
  assert.equal(lineFor("eip155:8453")?.key, "base");
  assert.equal(lineFor("sol")?.key, "solana");
  assert.equal(lineFor("not-a-chain"), null);
});

test("the interchange carries only cross-chain venues that serve production lines", () => {
  assert.ok(INTERCHANGE_VENUES.length >= 2);
  for (const venue of INTERCHANGE_VENUES) {
    assert.equal(venue.crossChain, true);
    assert.ok(venue.networks.some((network) => !LINES[network].yard), `${venue.name} serves a production line`);
  }
  const expected = PROTOCOLS.filter((protocol) => protocol.crossChain && protocol.networks.some((network) => CHAINS[network].lane !== "testnet"));
  assert.deepEqual(INTERCHANGE_VENUES.map((venue) => venue.id), expected.map((protocol) => protocol.id));
  assert.equal(venueOn("jupiter", "solana")?.name, "Jupiter");
  assert.equal(venueOn("jupiter", "base"), null, "a venue is only a station on networks it serves");
});

/* ---- route map ------------------------------------------------------------------- */

test("the map has a track for every production network and every station is a registry venue", () => {
  for (const line of PRODUCTION_LINES) assert.ok(MAPPED_NETWORKS.includes(line.key), `${line.name} has a track on the map`);
  assert.equal(TRACKS.length, PRODUCTION_LINES.length);
  for (const track of TRACKS) {
    assert.ok(isOctilinear(track.points), `${track.line.name} is octilinear`);
    assert.ok(track.stations.length >= 2, `${track.line.name} keeps its stations (registry drift drops them)`);
    for (const station of track.stations) {
      const protocol = PROTOCOLS.find((entry) => entry.id === station.venue);
      assert.ok(protocol?.networks.includes(track.line.key), `${station.label} serves ${track.line.name}`);
      assert.equal(station.label, protocol.name);
    }
  }
  assert.ok(isOctilinear(TRIP_POINTS));
});

test("map labels keep clear of each other and of the interchange", () => {
  // Rough text boxes: 7 units per character at 13 px, 13 units tall above the baseline.
  const boxes = [];
  for (const track of TRACKS) {
    for (const station of track.stations) {
      const place = labelPlacement(station);
      const width = station.label.length * 7;
      const x = place.anchor === "start" ? place.x : place.anchor === "end" ? place.x - width : place.x - width / 2;
      boxes.push({ name: `${track.line.key}/${station.label}`, x, y: place.y - 11, w: width, h: 13 });
    }
  }
  const capsule = { name: "interchange", x: INTERCHANGE.x, y: INTERCHANGE.y, w: INTERCHANGE.width, h: INTERCHANGE.height };
  const plate = { name: "Kletia plate", x: KLETIA_PLATE.x, y: KLETIA_PLATE.y, w: KLETIA_PLATE.width, h: KLETIA_PLATE.height };
  const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) assert.ok(!overlap(boxes[i], boxes[j]), `${boxes[i].name} clears ${boxes[j].name}`);
    assert.ok(!overlap(boxes[i], capsule), `${boxes[i].name} clears the interchange`);
    assert.ok(!overlap(boxes[i], plate), `${boxes[i].name} clears the Kletia plate`);
  }
  assert.ok(KLETIA_PLATE.y + KLETIA_PLATE.height < INTERCHANGE.y, "the Kletia plate hangs above the interchange");
  for (const track of TRACKS) {
    const [bx, by] = track.bullet;
    const [nx, ny] = track.name.at;
    if (track.name.anchor === "start" && Math.abs(ny - by) < 12) {
      assert.ok(nx >= bx + 23 + 3 + 12, `${track.line.name} name starts clear of its bullet and shadow`);
    }
  }
});

test("sign, yard and description are written from the registry", () => {
  const sign = signLayout();
  assert.equal(sign.items.length, INTERCHANGE_VENUES.length);
  assert.ok(sign.items.every((item) => item.x + item.name.length * 6.2 <= 452 + sign.width), "names fit the sign");
  const yard = yardLayout();
  assert.deepEqual(yard.rows.map((row) => row.line.key), YARD_LINES.map((line) => line.key));
  const text = mapDescription();
  for (const line of [...PRODUCTION_LINES, ...YARD_LINES]) assert.ok(text.includes(line.name), `description names ${line.name}`);
  for (const venue of INTERCHANGE_VENUES) assert.ok(text.includes(venue.name), `description names ${venue.name}`);
  assert.equal(joinNames(["A"]), "A");
  assert.equal(joinNames(["A", "B", "C"]), "A, B and C");
});

/* ---- icons, stamps, tickets ---------------------------------------------------- */

test("17 icons, each with line work and a plate", () => {
  assert.equal(ICON_NAMES.length, 17);
  for (const name of ICON_NAMES) {
    assert.ok(ICON_STROKES[name]?.startsWith("M"), `${name} strokes`);
    assert.ok(ICON_PLATES[name]?.startsWith("M"), `${name} plate`);
    assert.ok(isIconName(name));
  }
  assert.equal(isIconName("lucide"), false);
  for (const protocol of PROTOCOLS) {
    assert.ok(ICON_NAMES.includes(categoryIcon(protocol.category)));
    assert.match(categoryWord(protocol.category), /^[A-Z]/u);
  }
  assert.equal(categoryIcon("something-new"), "route", "unknown categories fall back");
});

test("stamp states have words", () => {
  assert.deepEqual([...STAMP_STATES], ["planned", "signed", "settled", "held", "failed"]);
  for (const state of STAMP_STATES) {
    assert.ok(STAMP_LABELS[state]);
    assert.match(STAMP_SENTENCES[state], /\.$/u);
  }
});

test("ticket formatting", () => {
  assert.equal(shortHash("0x8f2c71a4be0f57a33d6aa0b9e1c2f4d8"), "0x8f2c…f4d8");
  assert.equal(shortHash("0x1234"), "0x1234");
  assert.equal(legNumber(0), "01");
  assert.equal(countOf(3, 2), "2/2");
  assert.equal(countOf(-1, 2), "0/2");
  assert.equal(punchCount(3), 3);
  assert.equal(punchCount(12), 0, "long trips print the count instead of punches");
});

/* ---- stylesheets: AA contrast in both themes, motion rules -------------------- */

function cssVars(file, selector) {
  const css = readFileSync(join(artDir, file), "utf8");
  const block = css.match(new RegExp(`(?:^|\\n)${selector.replace(".", "\\.")} \\{([^}]*)\\}`, "u"));
  assert.ok(block, `${file} defines ${selector}`);
  return Object.fromEntries([...block[1].matchAll(/--([a-z-]+):\s*(#[0-9a-f]{3,6})\b/giu)].map((match) => [match[1], match[2]]));
}

test("art colours meet WCAG AA in light and dark", () => {
  for (const selector of [":root", ".dark"]) {
    const base = { ...cssVars("base.css", ":root"), ...(selector === ".dark" ? cssVars("base.css", ".dark") : {}) };
    const map = { ...cssVars("map.css", ":root"), ...(selector === ".dark" ? cssVars("map.css", ".dark") : {}) };
    const pairs = [
      ["map label on map paper", map["kla-map-text"], map["kla-map-paper"], 4.5],
      ["map small print on map paper", map["kla-map-muted"], map["kla-map-paper"], 4.5],
      ["map small print on the key card", map["kla-map-muted"], map["kla-map-card"], 4.5],
      ["map small print in the yard", map["kla-map-muted"], map["kla-map-yard"], 4.5],
      ["sign header text", map["kla-map-sign-text"], map["kla-map-sign"], 4.5],
      ["muted text on the page", base["kla-muted"], base["kla-paper"], 4.5],
      ["muted text on cards", base["kla-muted"], base["kla-card"], 4.5],
      ["links on the page", base["kla-link"], base["kla-paper"], 4.5],
      ["links on cards", base["kla-link"], base["kla-card"], 4.5],
      ["ticket ink on stock", base["kla-stock-ink"] ?? "#1a1a1a", base["kla-stock"], 4.5],
      ["ticket small print on stock", base["kla-stock-muted"], base["kla-stock"], 4.5],
      ["ticket links on stock", "#0047e0", base["kla-stock"], 4.5],
      ["focus ring on the page", base["kla-focus"], base["kla-paper"], 3],
    ];
    for (const [what, fg, bg, min] of pairs) {
      assert.ok(fg && bg, `${what}: colours found (${selector})`);
      const ratio = contrastRatio(fg, bg);
      assert.ok(ratio >= min, `${what} (${selector}): ${fg} on ${bg} is ${ratio.toFixed(2)}:1`);
    }
  }
  // Fixtures that look the same by day and by night.
  const fixed = [
    ["board text on board", "#f4f1ea", "#121418"],
    ["board headers on board", "#8b95a7", "#121418"],
    ["board note on board", "#a9b6c8", "#121418"],
    ["flap text on flap", "#f4f1ea", "#2b303b"],
    ["delayed flaps", "#ffd60a", "#2b303b"],
    ["no-service flaps", "#ff8a8d", "#2b303b"],
    ["checking flaps", "#a9b6c8", "#2b303b"],
    ["board title", "#ffd60a", "#1b1e25"],
    ["platform plate", "#1a1a1a", "#ffd60a"],
    ["sign board text", "#f4f1ea", "#1a1a1a"],
    ["spec text on blueprint (day)", "#ffffff", "#17407a"],
    ["spec text on blueprint (night)", "#ffffff", "#12335f"],
    ["spec yellow on blueprint (day)", "#ffd60a", "#17407a"],
    ["execute chip (day)", "#0047e0", "#fbfaf7"],
    ["execute chip (night)", "#7ea6ff", "#131e32"],
    ["verified badge", "#0b5c39", "#fffcf2"],
    ["planned ink", "#0047e0", "#fffcf2"],
    ["signed ink", "#6d28d9", "#fffcf2"],
    ["settled ink", "#0b7a4b", "#fffcf2"],
    ["held ink", "#a84b00", "#fffcf2"],
    ["failed ink", "#c8102e", "#fffcf2"],
    ["failed ink on night stock", "#c8102e", "#ece6d6"],
  ];
  for (const [what, fg, bg] of fixed) {
    const ratio = contrastRatio(fg, bg);
    const min = what.startsWith("spec yellow") ? 3 : 4.5;
    assert.ok(ratio >= min, `${what}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1`);
  }
});

test("every stylesheet with motion has a reduced-motion fallback, and art copy has no em dashes", () => {
  for (const file of readdirSync(artDir).filter((name) => /\.(?:tsx?|css)$/u.test(name))) {
    const source = readFileSync(join(artDir, file), "utf8").replace(/^\s*(?:\/\/|\*|\/\*).*$/gmu, "");
    if (file.endsWith(".css") && /animation:/u.test(source)) {
      assert.match(source, /@media \(prefers-reduced-motion: reduce\)/u, `${file} handles reduced motion`);
    }
    if (/\.(?:tsx?|css)$/u.test(file)) assert.ok(!source.includes("—"), `${file} has no em dash in code or copy`);
  }
  const barrel = readFileSync(join(artDir, "index.ts"), "utf8");
  assert.ok(!/\.css["']/u.test(barrel), "the barrel imports no CSS");
  // Components carry their stylesheets: the barrel may only re-export their types.
  const components = new Set(readdirSync(artDir).filter((name) => name.endsWith(".tsx")).map((name) => `./${name.slice(0, -4)}`));
  for (const match of barrel.matchAll(/export (type )?\{[^}]*\} from "([^"]+)"/gu)) {
    if (components.has(match[2])) assert.equal(match[1], "type ", `${match[2]} is re-exported as types only`);
  }
});
