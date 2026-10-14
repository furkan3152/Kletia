// The site's motion switch (portal design S-09): html[data-motion="off"] makes prefersReducedMotion() true whatever
// the operating system says, the choice is stored, and subscribers hear it. Run with
//   node --test apps/web/src/app/site/motion/__tests__/motionPreference.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const attributes = new Map();
const storage = new Map();
let osReduced = false;
globalThis.document = {
  documentElement: {
    getAttribute: (name) => attributes.get(name) ?? null,
    setAttribute: (name, value) => attributes.set(name, String(value)),
    removeAttribute: (name) => attributes.delete(name),
  },
};
globalThis.window = {
  matchMedia: () => ({ matches: osReduced, addEventListener() {}, removeEventListener() {} }),
  localStorage: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  },
};

const { applyMotionSetting, MOTION_STORAGE_KEY, prefersReducedMotion, readMotionSetting, setMotionSetting } = await import("../useReducedMotion.ts");

test('data-motion="off" makes prefersReducedMotion() true even when the OS allows motion', () => {
  osReduced = false;
  attributes.clear();
  assert.equal(prefersReducedMotion(), false);
  applyMotionSetting("off");
  assert.equal(attributes.get("data-motion"), "off");
  assert.equal(prefersReducedMotion(), true);
  applyMotionSetting("on");
  assert.equal(attributes.has("data-motion"), false);
  assert.equal(prefersReducedMotion(), false);
});

test("the OS setting still wins when the site switch is on", () => {
  osReduced = true;
  attributes.clear();
  assert.equal(prefersReducedMotion(), true);
  osReduced = false;
});

test("the switch is stored under kletia-site-motion and read back", () => {
  storage.clear();
  assert.equal(MOTION_STORAGE_KEY, "kletia-site-motion");
  assert.equal(readMotionSetting(), "on");
  setMotionSetting("off");
  assert.equal(storage.get(MOTION_STORAGE_KEY), "off");
  assert.equal(readMotionSetting(), "off");
  assert.equal(prefersReducedMotion(), true);
  setMotionSetting("on");
  assert.equal(storage.has(MOTION_STORAGE_KEY), false);
  assert.equal(prefersReducedMotion(), false);
});

test("index.html applies the stored setting before the first paint, and styles.css stops motion under it", () => {
  const html = readFileSync(new URL("../../../../../index.html", import.meta.url), "utf8");
  assert.match(html, /kletia-site-motion/u);
  assert.match(html, /data-motion/u);
  const css = readFileSync(new URL("../../../styles.css", import.meta.url), "utf8");
  assert.match(css, /html\[data-motion="off"\]/u);
});
