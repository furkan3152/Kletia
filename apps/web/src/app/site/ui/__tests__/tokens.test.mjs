// Contrast of the semantic colour tokens in styles.css (WCAG 2.2 AA). Run with Node 22.18 or later:
//   node --test apps/web/src/app/site/ui/__tests__/tokens.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../../../styles.css", import.meta.url), "utf8");

const TOKENS = [
  "paper",
  "surface",
  "surface-2",
  "text",
  "muted",
  "line",
  "control",
  "accent",
  "accent-text",
  "signal",
  "focus",
  "field-focus",
  "placeholder",
  "success",
  "success-bg",
  "info",
  "info-bg",
  "warning",
  "warning-bg",
  "danger",
  "danger-bg",
  "neutral",
  "neutral-bg",
];

/** The `--kl-*` hex values of the first `selector {` block that defines `--kl-paper`. */
function tokenBlock(selector) {
  const pattern = new RegExp(`(?:^|\\n)${selector.replace(".", "\\.")} \\{([^}]*--kl-paper[^}]*)\\}`, "u");
  const body = pattern.exec(css)?.[1];
  assert.ok(body, `no ${selector} block with the semantic tokens in styles.css`);
  const values = {};
  for (const [, name, value] of body.matchAll(/--kl-([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/gu)) values[name] = value.toLowerCase();
  return values;
}

const THEMES = { light: tokenBlock(":root"), dark: tokenBlock(".dark") };

function luminance(hex) {
  const [r, g, b] = hex
    .slice(1)
    .match(/../gu)
    .map((pair) => Number.parseInt(pair, 16) / 255)
    .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

test("both themes define every semantic token as a hex colour", () => {
  for (const [theme, values] of Object.entries(THEMES)) {
    for (const token of TOKENS) assert.match(values[token] ?? "", /^#[0-9a-f]{6}$/u, `${theme} --kl-${token}`);
  }
});

test("every text pair reaches 4.5:1 in both themes", () => {
  for (const [theme, t] of Object.entries(THEMES)) {
    const pairs = [
      ["text on paper", t.text, t.paper],
      ["text on surface", t.text, t.surface],
      ["text on surface-2", t.text, t["surface-2"]],
      ["muted on paper", t.muted, t.paper],
      ["muted on surface", t.muted, t.surface],
      ["muted on surface-2", t.muted, t["surface-2"]],
      ["accent text on paper", t["accent-text"], t.paper],
      ["accent text on surface", t["accent-text"], t.surface],
      ["white on the accent fill", "#ffffff", t.accent],
      ["ink on the signal yellow", "#1a1a1a", t.signal],
      // Inputs are white (the light surface) or the dark paper colour.
      ["placeholder in an input", t.placeholder, theme === "light" ? t.surface : t.paper],
      ["placeholder on surface", t.placeholder, t.surface],
      ["success", t.success, t["success-bg"]],
      ["info", t.info, t["info-bg"]],
      ["warning", t.warning, t["warning-bg"]],
      ["danger", t.danger, t["danger-bg"]],
      ["neutral", t.neutral, t["neutral-bg"]],
    ];
    for (const [name, foreground, background] of pairs) {
      const ratio = contrast(foreground, background);
      assert.ok(ratio >= 4.5, `${theme}: ${name} is ${ratio.toFixed(2)}:1 (${foreground} on ${background})`);
    }
  }
});

test("controls and the focus outline reach 3:1 on the page and on panels in both themes", () => {
  for (const [theme, t] of Object.entries(THEMES)) {
    for (const token of ["control", "focus", "field-focus"]) {
      for (const background of ["paper", "surface"]) {
        const ratio = contrast(t[token], t[background]);
        assert.ok(ratio >= 3, `${theme}: --kl-${token} on --kl-${background} is ${ratio.toFixed(2)}:1`);
      }
    }
  }
});

test("dark controls are no longer the 2.2-2.5:1 decorative ink", () => {
  assert.notEqual(THEMES.dark.control, THEMES.dark.line);
  assert.ok(contrast(THEMES.dark.line, THEMES.dark.surface) < 3, "the decorative line stays decorative");
});
