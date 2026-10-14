# Theming the widget and the embed

The React widget ([`@kletia/widget`](../../packages/widget/README.md)) and
the embed ([`<kletia-intent>`](embed.md)) take one set of appearance tokens,
`kletia.appearance/v1`: colours, corner radius, border, shadow, font, density
and header. One pure module in `@kletia/core` (`validateAppearance`,
`resolveAppearance`) validates them and turns them into CSS variables, so the
widget, the `/embed` frame and the API's project defaults agree on every
rule.

## Tokens

```ts
import type { KletiaAppearance } from "@kletia/core";

const appearance: KletiaAppearance = {
  colorScheme: "auto",                       // light, dark or auto (follows the visitor)
  light: { accent: "#6D28D9", surface: "#FFFFFF", ink: "#1E1B4B", line: "#1E1B4B" },
  dark: { accent: "#A78BFA", surface: "#17132B", ink: "#EDE9FE" },
  radius: 10,                                // 0-16 px, default 0
  border: 2,                                 // 1-3 px, default 3
  shadow: "soft",                            // hard (default), soft, none
  font: "system",                            // inter (default), system, serif, mono, rounded
  density: "compact",                        // comfortable (default), compact
  header: "kletia",                          // kletia (default), none
};
```

| Token | CSS variables | Rule |
|---|---|---|
| `surface`, `ink` | `--kw-paper`, `--kw-ink` | Text needs 4.5:1 on the surface. Otherwise the ink becomes the better of `#141414` and `#F4F4F5`; if neither reaches 4.5:1, the stock surface and ink are used. |
| (derived) muted | `--kw-muted` | The ink mixed 35 % toward the surface, then raised toward the ink until it reaches 4.5:1. |
| `line` | `--kw-line` | Needs 3:1 on the surface (WCAG 1.4.11), otherwise the ink. Without a line, a custom surface or ink uses the ink. |
| `accent`, `accentInk` | `--kw-accent`, `--kw-accent-ink`, `--kw-accent-text`, `--kw-focus` | Text on the accent needs 4.5:1; without `accentInk` (or with one that fails) the better of white and `#141414` is picked. Links use the accent only where it reaches 4.5:1 on the surface, the focus ring only where it reaches 3:1; otherwise the ink. |
| (derived) chip | `--kw-chip` | The surface mixed 6 % toward the ink. |
| `radius` | `--kw-radius` | 0–16 px on the widget, buttons, inputs, chips, cards, the fare, reviews and gates. Stamps stay square. |
| `border` | `--kw-border`, `--kw-border-inner` | 1–3 px; inner elements one pixel less (at least 1). |
| `shadow` | `--kw-shadow` | `hard` is the stock offset shadow; `soft` a light drop shadow; `none`. Buttons lose their offset shadow with `soft` and `none`. |
| `font` | `--kw-font` | Local font stacks only: no remote font URL is ever loaded. Amounts and codes keep the monospace stack. |
| `density` | `--kw-pad`, `--kw-gap`, `--kw-text` | comfortable 16/8/15 px, compact 12/6/14 px. Buttons keep `min-height: 44px`. |
| `header` | | `none` hides the header; the "Preview" or account label moves to the footer. `brand` (a verified project's name) needs a verified project profile and falls back to `kletia` until then. |

A dark scheme uses the `dark` palette. Without one it keeps the stock dark
colours and borrows only the light palette's accent.

In the embed, the same tokens are attributes (`accent`, `surface-dark`,
`radius`, …): see [the attribute table](embed.md#attributes).

## Contrast rules

Every fallback goes toward readability, never away from it:

- Body text 4.5:1 on the surface, muted text 4.5:1, text on the accent
  4.5:1 (WCAG 1.4.3).
- Borders and the focus ring 3:1 on the surface (WCAG 1.4.11).
- A colour that is not six hex digits is ignored, so no value can inject CSS
  (`red;}`, `url(…)` and `#12345g` are dropped). Numbers are clamped, names
  must be known, and only the documented variables are ever written.

`validateAppearance(input)` returns the cleaned value with `warnings`
(`COLOR_INVALID`, `CONTRAST_LOW`, `VALUE_OUT_OF_RANGE`, `UNKNOWN_VALUE`), and
refuses unknown fields, colours that are not `#RRGGBB` and unknown fonts.
`resolveAppearance(appearance, scheme)` returns the variables for one scheme
and the warnings of every fallback it took. Without an appearance it returns
no variables: the stock widget is unchanged, pixel for pixel.

```ts
import { resolveAppearance } from "@kletia/core";

resolveAppearance({ light: { ink: "#777777", surface: "#888888" } }, "light");
// vars: --kw-paper #888888, --kw-ink #141414, …; warnings: [CONTRAST_LOW light.ink]
```

## What never changes, and why

These surfaces carry consequences the visitor must see before signing, so no
token reaches them:

- the host notice ("*host* is notified…") and the external-recipient
  warning;
- the fare: its ticket stock in both schemes, the certainty labels and the
  yellow "at least" plate;
- contract reviews (who, what, permissions, result, provenance, "Not audited
  by Kletia"), acknowledgement gates and the second confirmation;
- policy holds and refusals, scope refusals ("Not available here"), errors;
- receipt stamps and step status colours;
- the footer ("Non-custodial · your wallet signs every step · Kletia"),
  which is always rendered;
- the journey ("where your money is after each step"), when shown, follows
  the surface, ink, line and radius tokens but can never be hidden.

Their colours are fixed variables (`--kw-ok`, `--kw-warn`, `--kw-bad`, the
`-ink` variants, `--kw-plate*`, `--kw-stock*`, `--kw-receipt-ink`) that the
resolver never writes.

## Presets

Starting points; adjust the accent to your brand.

| Preset | Tokens |
|---|---|
| Stock | none (the defaults) |
| Clean | `{ light: { surface: "#FFFFFF", ink: "#111827", line: "#D1D5DB" }, radius: 12, border: 1, shadow: "soft", font: "system" }` (the light line fails 3:1 on white, so borders use the ink; pick `#6B7280` or darker to keep a grey line) |
| Midnight | `{ colorScheme: "dark", dark: { accent: "#38BDF8", surface: "#0B1120", ink: "#E2E8F0", line: "#334155" }, radius: 8, border: 2, shadow: "none" }` |
| Compact | `{ density: "compact", radius: 6, border: 2, header: "none" }` |
| Editorial | `{ light: { accent: "#9F1239", surface: "#FFFBF5", ink: "#1C1917" }, font: "serif", radius: 2, border: 1, shadow: "none" }` |

## The React escape hatch

The widget writes its variables on its root element (`.kw-root`). In React
you can also override the same public variables from an ancestor:

```css
.checkout .kw-root {
  --kw-accent: #0f766e;
  --kw-radius: 8px;
}
```

Only these variables are public: `--kw-paper`, `--kw-ink`, `--kw-muted`,
`--kw-line`, `--kw-accent`, `--kw-accent-ink`, `--kw-accent-text`,
`--kw-chip`, `--kw-radius`, `--kw-border`, `--kw-border-inner`,
`--kw-shadow`, `--kw-font`, `--kw-pad`, `--kw-gap`, `--kw-text` and
`--kw-focus`. Every other `--kw-*` variable is internal and can change
without notice. A CSS override bypasses the contrast checks, so check it
yourself. Overriding the fixed safety variables above is unsupported: they
exist so that warnings look the same on every site. Inside the embed's frame your page's CSS does not
apply: use the attributes.
