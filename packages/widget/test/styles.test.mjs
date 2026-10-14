import assert from "node:assert/strict";
import test from "node:test";
import { APPEARANCE_FIXED_VARIABLES, APPEARANCE_PUBLIC_VARIABLES, resolveAppearance } from "@kletia/core";
import { WIDGET_CSS } from "../dist/styles.js";

/** [selector, declarations] for every rule (container and media blocks flattened). */
function rules(css) {
  const out = [];
  const flat = css.replace(/@(?:container|media)[^{]*\{((?:[^{}]*\{[^{}]*\})*)\s*\}/gu, "$1");
  for (const match of flat.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    const declarations = match[2].split(";").map((item) => item.trim()).filter(Boolean).map((item) => {
      const colon = item.indexOf(":");
      return [item.slice(0, colon).trim(), item.slice(colon + 1).trim()];
    });
    out.push([match[1].trim(), declarations]);
  }
  return out;
}

const ALL = rules(WIDGET_CSS);
const rulesOf = (className) => ALL.filter(([selector]) => selector.split(",").some((part) => new RegExp(`^\\.${className}(?![\\w-])(?!.*\\s)`, "u").test(part.trim())));

/** Classes appearance tokens restyle: their borders, padding, gaps, radius and fonts read variables. */
const THEMABLE = ["kw-root", "kw-textarea", "kw-chip", "kw-btn", "kw-summary", "kw-step", "kw-input", "kw-gate", "kw-review", "kw-stopped", "kw-share", "kw-journey", "kw-card", "kw-opt", "kw-assume-chip", "kw-jr-outcome"];
/** Safety surfaces: their colours are fixed, never a public (themable) variable. */
const SAFETY = ["kw-status", "kw-plate", "kw-stamp", "kw-stamp-warn", "kw-stamp-bad", "kw-stamp-receipt", "kw-review-notice", "kw-policy-held", "kw-policy-refused", "kw-policy-tag", "kw-fare-changed", "kw-fare-need", "kw-sev", "kw-jr-here", "kw-jr-notice"];

test("every border and padding of a themable class uses a variable", () => {
  for (const className of THEMABLE) {
    const found = rulesOf(className);
    assert.ok(found.length > 0, className);
    let borders = 0;
    for (const [selector, declarations] of found) {
      for (const [property, value] of declarations) {
        if (/^(border|padding)$/u.test(property) || property === "border-radius") {
          assert.match(value, /var\(--kw-/u, `${selector} ${property}:${value}`);
          if (property === "border") borders += 1;
        }
        if (property === "font-family") assert.match(value, /var\(--kw-font\)/u, selector);
      }
    }
    if (className !== "kw-root" || borders > 0) assert.ok(found.some(([, d]) => d.some(([p]) => p === "border-radius")), `${className} has a radius`);
  }
});

test("the root declares every public variable a stock value (zero-diff defaults)", () => {
  const root = ALL.filter(([selector]) => selector === ".kw-root").flatMap(([, declarations]) => declarations);
  const declared = new Set(root.map(([property]) => property));
  for (const name of APPEARANCE_PUBLIC_VARIABLES) {
    if (name === "--kw-accent-text" || name === "--kw-focus") continue; // fall back to the accent in the light scheme
    assert.ok(declared.has(name), name);
  }
  const value = (name) => root.find(([property]) => property === name)?.[1];
  assert.equal(value("--kw-radius"), "0px");
  assert.equal(value("--kw-border"), "3px");
  assert.equal(value("--kw-border-inner"), "2px");
  assert.equal(value("--kw-pad"), "16px");
});

test("safety classes keep fixed colours", () => {
  const publicVars = new Set(APPEARANCE_PUBLIC_VARIABLES);
  for (const className of SAFETY) {
    const found = rulesOf(className);
    assert.ok(found.length > 0, className);
    for (const [selector, declarations] of found) {
      for (const [property, value] of declarations) {
        // Colours of the sign itself; a border may follow the themable line colour.
        if (!/^(color|background|background-color|border-color)$/u.test(property)) continue;
        for (const variable of value.matchAll(/var\((--kw-[\w-]+)/gu)) {
          assert.ok(!publicVars.has(variable[1]), `${selector} ${property}:${value}`);
        }
      }
    }
  }
  // The fare keeps its ticket stock in both schemes.
  const fare = rulesOf("kw-fare").flatMap(([, declarations]) => declarations);
  assert.ok(fare.some(([property, value]) => property === "background" && value === "var(--kw-stock)"));
  assert.ok(fare.some(([property, value]) => property === "color" && value === "var(--kw-stock-ink)"));
});

test("fixed variables are declared by the widget and never by the resolver", () => {
  const declared = new Set(ALL.flatMap(([, declarations]) => declarations.map(([property]) => property)));
  for (const name of APPEARANCE_FIXED_VARIABLES) assert.ok(declared.has(name), name);
  const vars = resolveAppearance({ light: { accent: "#D92D20", surface: "#000000", ink: "#FFFFFF" }, radius: 8, border: 1, shadow: "none", font: "mono", density: "compact" }, "light").vars;
  for (const name of Object.keys(vars)) assert.ok(!APPEARANCE_FIXED_VARIABLES.includes(name), name);
});

test("density and shadow switches exist for the attributes the widget sets", () => {
  assert.ok(ALL.some(([selector]) => selector === '.kw-root[data-density="compact"]'));
  assert.ok(ALL.some(([selector]) => selector.includes('.kw-root[data-shadow="none"]')));
  assert.ok(ALL.some(([selector, declarations]) => selector.startsWith(".kw-btn") && declarations.some(([p, v]) => p === "box-shadow" && v === "var(--kw-btn-shadow)")));
});

test("journey signage: every severity has a fixed sign colour, and nothing moves under reduced motion", () => {
  for (const severity of ["block", "act", "warn", "info"]) {
    const rule = ALL.find(([selector]) => selector === `.kw-sev[data-severity="${severity}"]`);
    assert.ok(rule, severity);
    const background = rule[1].find(([property]) => property === "background")?.[1];
    const color = rule[1].find(([property]) => property === "color")?.[1];
    assert.match(background, /^#[0-9a-f]{6}$/u, `${severity} background is a fixed colour`);
    assert.match(color, /^#[0-9a-f]{6}$/u, `${severity} ink is a fixed colour`);
  }
  const reduced = WIDGET_CSS.match(/@media \(prefers-reduced-motion:reduce\)\{(.*)\}\s*$/mu)?.[1] ?? "";
  assert.ok(reduced.includes(".kw-card{animation:none}"));
  // Options stack full width in a narrow widget (phones).
  assert.ok(/@container kw \(max-width:400px\)\{[^\n]*\.kw-opts\{grid-template-columns:minmax\(0,1fr\)\}/u.test(WIDGET_CSS));
});
