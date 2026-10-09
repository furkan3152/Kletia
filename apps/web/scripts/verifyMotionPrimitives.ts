/**
 * Verifies the pure, Node-safe parts of the site motion system
 * (src/app/site/motion and src/app/site/ui): tokens, deterministic jitter and
 * confetti, monogram letters and contrast, the toast store and the View
 * Transition fallback. Run: `npx tsx scripts/verifyMotionPrimitives.ts`.
 */
import assert from "node:assert/strict";

import { PROTOCOLS } from "@kletia/core";

import {
  clamp01,
  cssVars,
  decimalsOf,
  DURATION,
  easeOutExpo,
  roundLike,
  seededRandom,
  STAGGER,
  staggerDelay,
  staggerIndex,
  typingJitter,
} from "../src/app/site/motion/tokens";
import { formatLatency, padFlaps, riffleDuration, riffleFrame } from "../src/app/site/art/boardFormat";
import { rounded } from "../src/app/site/art/geometry";
import { confettiParticles, stepParticle } from "../src/app/site/motion/celebrate";
import { runViewTransition, supportsViewTransitions } from "../src/app/site/motion/viewTransition";
import {
  categoryColor,
  contrastRatio,
  MONOGRAM_CATEGORIES,
  monogramFor,
} from "../src/app/site/ui/monogramStyle";
import {
  createToastRecord,
  DEFAULT_TOAST_DURATION,
  getToasts,
  MAX_VISIBLE_TOASTS,
  subscribeToasts,
  toast,
  TOAST_EXIT_MS,
  upsertToast,
  visibleToasts,
} from "../src/app/site/ui/toast";

// Tokens ----------------------------------------------------------------------
assert.equal(staggerDelay(0), 0);
assert.equal(staggerDelay(1), STAGGER.step);
assert.equal(staggerDelay(8), 480, "stagger caps at 8 items (480 ms)");
assert.equal(staggerDelay(40), 480);
assert.equal(staggerDelay(-3), 0);
assert.equal(staggerDelay(Number.NaN), 0);
assert.equal(staggerIndex(12), STAGGER.maxItems);
assert.equal(clamp01(-1), 0);
assert.equal(clamp01(2), 1);
assert.equal(easeOutExpo(0), 0);
assert.equal(easeOutExpo(1), 1);
assert.equal(easeOutExpo(5), 1);
for (let t = 0.05; t < 1; t += 0.05) assert.ok(easeOutExpo(t) > easeOutExpo(t - 0.05), "easeOutExpo is monotonic");
assert.equal(decimalsOf(12), 0);
assert.equal(decimalsOf(0.25), 2);
assert.equal(decimalsOf(1.23456), 3);
assert.equal(roundLike(11.73, 12), 12, "integer targets never show fractions mid-tween");
assert.equal(roundLike(0.123, 0.25), 0.12);
assert.equal(DURATION.count, 900);
assert.deepEqual(cssVars({ "--kl-i": 2, "--kl-delay": undefined }), { "--kl-i": 2 });
for (let index = 0; index < 200; index += 1) {
  const jitter = typingJitter(index);
  assert.ok(Number.isInteger(jitter) && jitter >= 0 && jitter <= 12, "typing jitter stays within 0–12 ms");
  assert.equal(jitter, typingJitter(index), "typing jitter is deterministic");
}
{
  const a = seededRandom(42);
  const b = seededRandom(42);
  for (let index = 0; index < 20; index += 1) {
    const value = a();
    assert.equal(value, b());
    assert.ok(value >= 0 && value < 1);
  }
}

// Confetti ----------------------------------------------------------------------
{
  const origin = { x: 400, y: 300 };
  const first = confettiParticles(origin, { seed: 7 });
  const second = confettiParticles(origin, { seed: 7 });
  assert.equal(first.length, 90, "default burst has 90 particles");
  assert.deepEqual(first, second, "the same seed gives the same burst");
  for (const particle of first) {
    assert.ok(particle.vy < 0, "every particle starts upward");
    const angle = Math.abs((Math.atan2(particle.vx, -particle.vy) * 180) / Math.PI);
    assert.ok(angle <= 60.0001, "bursts stay within ±60° of vertical");
    const bar = particle.width === 4 && particle.height === 12;
    const square = particle.width === particle.height && particle.width >= 6 && particle.width <= 10;
    assert.ok(bar || square, "particles are 4×12 bars or 6–10px squares");
  }
  const particle = { ...first[0]! };
  const before = particle.vy;
  stepParticle(particle, 0.1);
  assert.ok(particle.vy > before, "gravity pulls particles down");
  assert.equal(confettiParticles(origin, { count: 0 }).length, 0);
}

// Monograms ---------------------------------------------------------------------
assert.deepEqual(monogramFor("Uniswap V3"), { letters: "UN", version: "v3" });
assert.deepEqual(monogramFor("Kletia Intent Router V2"), { letters: "KI", version: "v2" });
assert.deepEqual(monogramFor("Circle CCTP V2"), { letters: "CC", version: "v2" });
assert.deepEqual(monogramFor("Jupiter / Sanctum LSTs"), { letters: "JS" });
assert.deepEqual(monogramFor("Jupiter"), { letters: "JU" });
assert.deepEqual(monogramFor("x402 payments"), { letters: "XP" });
assert.deepEqual(monogramFor("ERC-20 transfer"), { letters: "ET" });
assert.deepEqual(monogramFor(""), { letters: "?" });
for (const protocol of PROTOCOLS) {
  const { letters } = monogramFor(protocol.name);
  assert.match(letters, /^\p{Lu}{1,2}$/u, `monogram for ${protocol.name}`);
}
for (const category of [...MONOGRAM_CATEGORIES, "something-new"]) {
  const color = categoryColor(category);
  assert.ok(contrastRatio(color.bg, color.fg) >= 4.5, `${category} monogram text reaches 4.5:1`);
  if (color.darkBg && color.darkFg) assert.ok(contrastRatio(color.darkBg, color.darkFg) >= 4.5);
}
for (const protocol of PROTOCOLS) assert.ok(categoryColor(protocol.category).bg.startsWith("#"));
assert.deepEqual(categoryColor("unknown-category"), { bg: "#4B5563", fg: "#FFFFFF" });
assert.equal(categoryColor("token-program").darkBg, "#E2E8F0", "ink tiles turn light in dark mode");
assert.ok(Math.abs(contrastRatio("#FFFFFF", "#000000") - 21) < 1e-9);

// Toast store -------------------------------------------------------------------
{
  const info = createToastRecord({ title: "Saved" }, "a");
  assert.equal(info.tone, "info");
  assert.equal(info.duration, DEFAULT_TOAST_DURATION.info);
  assert.equal(createToastRecord({ title: "x", tone: "error" }, "b").duration, 8000);
  assert.equal(createToastRecord({ title: "x", tone: "warning" }, "c").duration, 6000);
  assert.equal(createToastRecord({ title: "x", duration: "persistent" }, "d").duration, "persistent");
  assert.equal(createToastRecord({ title: "x", duration: -5 }, "e").duration, 4000);

  let list = upsertToast([], info);
  list = upsertToast(list, createToastRecord({ title: "Saved again" }, "a"));
  assert.equal(list.length, 1, "the same id replaces instead of stacking");
  assert.equal(list[0]!.title, "Saved again");
  assert.equal(list[0]!.revision, 1);
  for (const id of ["f", "g", "h", "i"]) list = upsertToast(list, createToastRecord({ title: id }, id));
  assert.equal(visibleToasts(list).length, MAX_VISIBLE_TOASTS, "at most three toasts are visible");
  assert.equal(visibleToasts(list)[0]!.id, "a", "the oldest toast stays first; extras queue");

  let notified = 0;
  const unsubscribe = subscribeToasts(() => {
    notified += 1;
  });
  const id = toast.success("Copied to clipboard", { id: "copy" });
  assert.equal(id, "copy");
  toast.success("Copied to clipboard", { id: "copy" });
  assert.equal(getToasts().filter((record) => record.id === "copy").length, 1);
  const generated = toast.error("Planning failed", { description: "Try again.", silent: true });
  assert.ok(generated.startsWith("kl-toast-"));
  assert.equal(getToasts().find((record) => record.id === generated)?.silent, true);
  toast.dismiss("copy");
  assert.equal(getToasts().find((record) => record.id === "copy")?.leaving, true, "dismiss starts the exit");
  await new Promise((resolve) => setTimeout(resolve, TOAST_EXIT_MS + 40));
  assert.equal(getToasts().some((record) => record.id === "copy"), false, "dismissed toasts are removed after the exit");
  toast.dismiss();
  await new Promise((resolve) => setTimeout(resolve, TOAST_EXIT_MS + 40));
  assert.equal(getToasts().length, 0, "dismiss() clears every toast");
  assert.ok(notified >= 5);
  unsubscribe();
}

// View Transition fallback --------------------------------------------------------
{
  assert.equal(supportsViewTransitions(), false, "no document in Node");
  let ran = 0;
  await runViewTransition("route", () => {
    ran += 1;
  });
  assert.equal(ran, 1, "without the API the update runs synchronously, exactly once");
}

// Art system (src/app/site/art; full suite: node --test src/app/site/art/__tests__) ----
{
  assert.equal(formatLatency(96), "96 MS");
  assert.equal(formatLatency(1840), "1.84 S");
  assert.equal(formatLatency(null), "--- MS");
  for (let ms = 0; ms < 150_000; ms += 13.7) assert.ok(formatLatency(ms).length <= 6, "latency fits six flap tiles");
  const from = padFlaps("", 6);
  const to = padFlaps("212 ms", 6);
  assert.equal(riffleFrame(from, to, riffleDuration(from, to)).text, to, "the split flaps land on the value");
  assert.equal(rounded([[0, 0], [100, 0], [100, 100]]), "M0 0L82 0Q100 0 100 18L100 100");
}

console.log(
  "Motion primitives verified: tokens and stagger caps, deterministic typing jitter and confetti, monogram letters and 4.5:1 tile contrast, toast queue/dedupe/exit, View Transition fallback, split-flap latency and route-map geometry.",
);
