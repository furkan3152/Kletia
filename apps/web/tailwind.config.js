export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        kletiaDark: "#0D0D0D",
        kletiaGray: "#212121",
        kletiaBlue: "#0052FF",
        // Legacy site palette names, now the Card machine's colours. Prefer the
        // semantic tokens below or the kit's `k` colours in new code.
        kl: {
          ink: "#121212",
          paper: "#D6D2C8",
          "paper-2": "#CBC6BB",
          card: "#F1EEE7",
          stock: "#FBFAF6",
          "stock-night": "#ECE6D6",
          blue: "#2F5BFF",
          "blue-soft": "#8FA6FF",
          yellow: "#C6FF3A",
          purple: "#9945FF",
          green: "#14F195",
          "green-ink": "#0B7A4B",
          red: "#FF5A5F",
          night: "#0E0E10",
          "night-2": "#19191C",
          "night-3": "#232327",
          slate: "#4B5563",
          "slate-shadow": "#2A2A30",
          muted: "#5C5850",
          "muted-dark": "#9A968C",
        },
        // Card machine design tokens (src/app/kit/index.ts): CSS variables on :root and .dark
        // in styles.css, so `bg-k-chassis`, `text-k-ink-3`, `border-k-line` follow both themes.
        lime: { DEFAULT: "var(--k-lime)", edge: "var(--k-lime-edge)", tint: "var(--k-lime-tint)" },
        magenta: { DEFAULT: "var(--k-magenta)", edge: "var(--k-magenta-edge)", tint: "var(--k-magenta-tint)" },
        k: {
          chassis: "var(--k-chassis)",
          "chassis-2": "var(--k-chassis-2)",
          panel: "var(--k-panel)",
          "panel-2": "var(--k-panel-2)",
          raised: "var(--k-raised)",
          screen: "var(--k-screen)",
          stock: "var(--k-stock)",
          ink: "var(--k-ink)",
          "ink-2": "var(--k-ink-2)",
          "ink-3": "var(--k-ink-3)",
          line: "var(--k-line)",
          "line-2": "var(--k-line-2)",
          key: "var(--k-key)",
          "key-edge": "var(--k-key-edge)",
          well: "var(--k-well)",
          up: "var(--k-up)",
          down: "var(--k-down)",
          blue: "var(--k-blue)",
        },
        // Semantic tokens: CSS variables on :root and .dark in styles.css, so
        // one class follows both themes (bg-surface, text-fg, text-muted,
        // border-control, outline-focus...).
        paper: "var(--kl-paper)",
        surface: { DEFAULT: "var(--kl-surface)", 2: "var(--kl-surface-2)" },
        fg: "var(--kl-text)",
        muted: "var(--kl-muted)",
        line: "var(--kl-line)",
        control: "var(--kl-control)",
        accent: { DEFAULT: "var(--kl-accent)", text: "var(--kl-accent-text)" },
        signal: "var(--kl-signal)",
        focus: "var(--kl-focus)",
        placeholder: "var(--kl-placeholder)",
        success: { DEFAULT: "var(--kl-success)", bg: "var(--kl-success-bg)" },
        info: { DEFAULT: "var(--kl-info)", bg: "var(--kl-info-bg)" },
        warning: { DEFAULT: "var(--kl-warning)", bg: "var(--kl-warning-bg)" },
        danger: { DEFAULT: "var(--kl-danger)", bg: "var(--kl-danger-bg)" },
        neutral: { DEFAULT: "var(--kl-neutral)", bg: "var(--kl-neutral-bg)" },
      },
      // Type scale with a 12 px floor. Anything a user must read is at least
      // `text-label` / `text-code-s` (0.75rem); smaller sizes are for aria-hidden
      // ornament only (site/ui/__tests__/typeFloor.test.mjs).
      fontSize: {
        "display-l": ["clamp(2.5rem, 6vw, 4.25rem)", { lineHeight: "1", letterSpacing: "-0.045em" }],
        "display-m": ["2.5rem", { lineHeight: "1.05", letterSpacing: "-0.035em" }],
        "display-s": ["1.75rem", { lineHeight: "1.15", letterSpacing: "-0.02em" }],
        title: ["1.25rem", { lineHeight: "1.3" }],
        "body-l": ["1.125rem", { lineHeight: "1.6" }],
        body: ["1rem", { lineHeight: "1.6" }],
        "body-s": ["0.875rem", { lineHeight: "1.55" }],
        label: ["0.75rem", { lineHeight: "1.3", letterSpacing: "0.08em", fontWeight: "800" }],
        code: ["0.8125rem", { lineHeight: "1.6" }],
        "code-s": ["0.75rem", { lineHeight: "1.5" }],
      },
      // The three tracking values of the scale.
      letterSpacing: {
        display: "-0.035em",
        title: "-0.02em",
        label: "0.08em",
      },
      // Hard offset shadows. `--kl-shadow-ink` is #1A1A1A in light and
      // #475569 under `.dark` (see styles.css), so one class covers both themes.
      boxShadow: {
        "hard-sm": "3px 3px 0 var(--kl-shadow-ink)",
        hard: "4px 4px 0 var(--kl-shadow-ink)",
        "hard-md": "5px 5px 0 var(--kl-shadow-ink)",
        "hard-lg": "8px 8px 0 var(--kl-shadow-ink)",
        "hard-xl": "10px 10px 0 var(--kl-shadow-ink)",
        // Card machine: the slab (card, composer, ticket only), raised objects, keys.
        slab: "5px 5px 0 var(--k-slab-shadow)",
        "slab-sm": "3px 3px 0 var(--k-slab-shadow)",
        obj: "var(--k-obj)",
        key: "inset 0 1px 0 var(--k-hi), 0 4px 0 var(--k-key-edge), 0 5px 10px -4px rgba(0,0,0,.25)",
      },
      borderRadius: {
        key: "10px",
        card: "16px",
        module: "20px",
      },
      // Motion tokens (mirrored in src/app/site/motion/tokens.ts).
      transitionTimingFunction: {
        "kl-out": "var(--kl-ease-out)",
        "kl-standard": "var(--kl-ease-standard)",
        "kl-in": "var(--kl-ease-in)",
        "kl-snap": "var(--kl-ease-snap)",
        mech: "cubic-bezier(.7,0,.2,1)",
      },
      transitionDuration: {
        60: "60ms",
        90: "90ms",
        240: "240ms",
        420: "420ms",
      },
      // Card machine type: Funnel Display for display, Funnel Sans for UI and body,
      // Geist Mono for every amount, hash and time, Doto only for the card serial and the LCD.
      // Loaded from Google Fonts by index.html (preconnect, display=swap, Latin subsets).
      fontFamily: {
        display: ["var(--k-f-display)"],
        body: ["var(--k-f-ui)"],
        code: ["var(--k-f-mono)"],
        led: ["var(--k-f-led)"],
        sans: ["var(--k-f-ui)"],
        mono: ["var(--k-f-mono)"],
      },
    },
  },
  plugins: [],
};
