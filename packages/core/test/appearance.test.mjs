import assert from "node:assert/strict";
import test from "node:test";
import {
  APPEARANCE_FIXED_VARIABLES,
  APPEARANCE_FONT_STACKS,
  APPEARANCE_PUBLIC_VARIABLES,
  APPEARANCE_SCHEME_COLORS,
  appearanceFromParams,
  appearanceToParams,
  contrastRatio,
  resolveAppearance,
  validateAppearance,
} from "../dist/index.js";

const codes = (warnings) => warnings.map((warning) => warning.code);

test("contrastRatio follows WCAG 2.x", () => {
  assert.equal(Math.round(contrastRatio("#FFFFFF", "#000000") * 100) / 100, 21);
  assert.equal(contrastRatio("#777777", "#777777"), 1);
  assert.equal(contrastRatio("red;}", "#FFFFFF"), 1);
});

test("no appearance emits nothing: the stock widget stays pixel-identical", () => {
  for (const scheme of ["light", "dark"]) {
    const resolved = resolveAppearance(undefined, scheme);
    assert.deepEqual(resolved.vars, {});
    assert.equal(resolved.header, "kletia");
    assert.deepEqual(resolveAppearance({}, scheme).vars, {});
  }
});

test("a faint ink falls back to the readable fallback ink with CONTRAST_LOW", () => {
  const resolved = resolveAppearance({ light: { ink: "#777777", surface: "#888888" } }, "light");
  assert.ok(codes(resolved.warnings).includes("CONTRAST_LOW"));
  assert.equal(resolved.vars["--kw-paper"], "#888888");
  assert.equal(resolved.vars["--kw-ink"], "#141414");
  assert.ok(contrastRatio(resolved.vars["--kw-ink"], resolved.vars["--kw-paper"]) >= 4.5);
  assert.ok(contrastRatio(resolved.vars["--kw-muted"], resolved.vars["--kw-paper"]) >= 4.5);
});

test("a surface no ink can read on gives the stock pair (no paper or ink override) and CONTRAST_LOW", () => {
  const resolved = resolveAppearance({ light: { ink: "#777777", surface: "#767676" } }, "light");
  assert.ok(codes(resolved.warnings).includes("CONTRAST_LOW"));
  assert.equal(resolved.vars["--kw-paper"], undefined);
  assert.equal(resolved.vars["--kw-ink"], undefined);
  const dark = resolveAppearance({ dark: { ink: "#777777", surface: "#767676" } }, "dark");
  assert.ok(codes(dark.warnings).includes("CONTRAST_LOW"));
  assert.equal(dark.vars["--kw-paper"], undefined);
});

test("the accent ink is picked automatically, and a failing one is replaced", () => {
  assert.equal(resolveAppearance({ light: { accent: "#FFD60A" } }, "light").vars["--kw-accent-ink"], "#141414");
  assert.equal(resolveAppearance({ light: { accent: "#0B3D2E" } }, "light").vars["--kw-accent-ink"], "#FFFFFF");
  const forced = resolveAppearance({ light: { accent: "#0B3D2E", accentInk: "#0A0A0A" } }, "light");
  assert.equal(forced.vars["--kw-accent-ink"], "#FFFFFF");
  assert.ok(codes(forced.warnings).includes("CONTRAST_LOW"));
  // A light accent is unreadable as link text on the stock paper: links and focus use the ink.
  const yellow = resolveAppearance({ light: { accent: "#FFD60A" } }, "light");
  assert.equal(yellow.vars["--kw-accent-text"], APPEARANCE_SCHEME_COLORS.light.ink);
  assert.equal(yellow.vars["--kw-focus"], APPEARANCE_SCHEME_COLORS.light.ink);
});

test("a faint border falls back to the ink", () => {
  const resolved = resolveAppearance({ light: { surface: "#FFFFFF", ink: "#1E293B", line: "#F0F0F0" } }, "light");
  assert.equal(resolved.vars["--kw-line"], "#1E293B");
  assert.ok(codes(resolved.warnings).includes("CONTRAST_LOW"));
  // On the stock paper the stock line applies: nothing to override.
  const stock = resolveAppearance({ light: { line: "#F0F0F0" } }, "light");
  assert.equal(stock.vars["--kw-line"], undefined);
  assert.ok(codes(stock.warnings).includes("CONTRAST_LOW"));
});

test("the dark scheme borrows only the light accent when it has no palette of its own", () => {
  const resolved = resolveAppearance({ light: { accent: "#7C3AED", surface: "#FFFFFF" } }, "dark");
  assert.equal(resolved.vars["--kw-accent"], "#7C3AED");
  assert.equal(resolved.vars["--kw-paper"], undefined);
});

test("invalid hex and CSS-injection strings are never emitted", () => {
  for (const evil of ["red;}", "url(https://evil.example/x.png)", "#12345g", "#FFF", "#0052ff;background:red", "expression(alert(1))"]) {
    const resolved = resolveAppearance({ light: { accent: evil, surface: evil } }, "light");
    assert.deepEqual(resolved.vars, {}, evil);
    assert.ok(codes(resolved.warnings).includes("COLOR_INVALID"), evil);
    const strict = validateAppearance({ light: { accent: evil } });
    assert.equal(strict.ok, false, evil);
    const lenient = appearanceFromParams(new URLSearchParams({ accent: evil, "surface-dark": evil }));
    assert.deepEqual(lenient.appearance, {}, evil);
    assert.equal(lenient.warnings.length, 2);
  }
  // Every emitted value is a hex colour, a px length or a value from a fixed table.
  const all = resolveAppearance({ light: { accent: "#123456", surface: "#FAFAFA", ink: "#202020", line: "#404040" }, radius: 8, border: 2, shadow: "soft", font: "mono", density: "compact" }, "light");
  const fixed = new Set([...Object.values(APPEARANCE_FONT_STACKS), "0 1px 2px rgb(0 0 0 / .06), 0 8px 24px rgb(0 0 0 / .08)"]);
  for (const value of Object.values(all.vars)) assert.ok(/^#[0-9A-F]{6}$/u.test(value) || /^\d{1,2}px$/u.test(value) || fixed.has(value), value);
});

test("radius and border are clamped", () => {
  const strict = validateAppearance({ radius: 40, border: 0 });
  assert.equal(strict.ok, true);
  assert.equal(strict.value.radius, 16);
  assert.equal(strict.value.border, 1);
  assert.deepEqual(codes(strict.warnings), ["VALUE_OUT_OF_RANGE", "VALUE_OUT_OF_RANGE"]);
  const resolved = resolveAppearance({ radius: -5, border: 9 }, "light");
  assert.equal(resolved.vars["--kw-radius"], "0px");
  assert.equal(resolved.vars["--kw-border"], "3px");
  assert.equal(resolved.vars["--kw-border-inner"], "2px");
  assert.equal(resolveAppearance({ border: 1 }, "light").vars["--kw-border-inner"], "1px");
  const params = appearanceFromParams(new URLSearchParams("radius=99&border=0"));
  assert.deepEqual(params.appearance, { radius: 16, border: 1 });
});

test("unknown fonts and fields are refused by the validator and ignored by the resolver", () => {
  const strict = validateAppearance({ font: "comic-sans" });
  assert.equal(strict.ok, false);
  assert.equal(strict.issues[0].path, "appearance.font");
  assert.equal(validateAppearance({ fontUrl: "https://fonts.example/x.css" }).ok, false);
  assert.equal(resolveAppearance({ font: "comic-sans" }, "light").vars["--kw-font"], undefined);
  assert.equal(appearanceFromParams(new URLSearchParams("font=papyrus")).appearance.font, undefined);
  assert.equal(validateAppearance({ font: "serif" }).value.font, "serif");
});

test("safety variables are never emitted and every emitted variable is public", () => {
  const resolved = resolveAppearance(
    { colorScheme: "dark", light: { accent: "#D92D20", surface: "#000000", ink: "#FFFFFF", line: "#FFFFFF", accentInk: "#FFFFFF" }, dark: { accent: "#0E9F6E", surface: "#FFFFFF", ink: "#000000" }, radius: 16, border: 1, shadow: "none", font: "system", density: "compact", header: "none" },
    "light",
  );
  for (const name of Object.keys(resolved.vars)) {
    assert.ok(APPEARANCE_PUBLIC_VARIABLES.includes(name), name);
    assert.ok(!APPEARANCE_FIXED_VARIABLES.includes(name), name);
    assert.ok(name.startsWith("--kw-"), name);
  }
  for (const name of APPEARANCE_FIXED_VARIABLES) assert.ok(!APPEARANCE_PUBLIC_VARIABLES.includes(name));
  assert.equal(resolved.header, "none");
});

test("the brand header needs a verified project", () => {
  assert.equal(resolveAppearance({ header: "brand" }, "light").header, "kletia");
  assert.equal(resolveAppearance({ header: "brand" }, "light", { brandVerified: true }).header, "brand");
});

test("density sets padding, gap and text size", () => {
  const vars = resolveAppearance({ density: "compact" }, "light").vars;
  assert.deepEqual([vars["--kw-pad"], vars["--kw-gap"], vars["--kw-text"]], ["12px", "6px", "14px"]);
});

test("the query form round-trips", () => {
  const appearance = { light: { accent: "#7C3AED", surface: "#FFFFFF" }, dark: { accent: "#A78BFA" }, radius: 8, border: 2, shadow: "soft", font: "rounded", density: "compact", header: "none" };
  const params = appearanceToParams(appearance);
  assert.deepEqual(params.slice(0, 3), [["accent", "7C3AED"], ["surface", "FFFFFF"], ["accent-dark", "A78BFA"]]);
  const back = appearanceFromParams(new URLSearchParams(params));
  assert.deepEqual(back.appearance, appearance);
  assert.deepEqual(back.warnings, []);
  assert.equal(appearanceFromParams(new URLSearchParams("accent=%237c3aed")).appearance.light.accent, "#7C3AED");
});
