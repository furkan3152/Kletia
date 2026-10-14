import defaultTheme from "tailwindcss/defaultTheme.js";

export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        kletiaDark: "#0D0D0D",
        kletiaGray: "#212121",
        kletiaBlue: "#0052FF",
        // Site palette (neo-brutalist). `kl-ink` is the border/shadow ink; the
        // `night` shades are the dark theme surfaces.
        kl: {
          ink: "#1A1A1A",
          paper: "#F4F1EA",
          "paper-2": "#EDE9DF",
          card: "#FBFAF7",
          // Ticket and notice stock (the art's --kla-stock): printed objects
          // keep this paper at night, so `stock-night` is its slightly
          // dimmed night printing, not a dark surface.
          stock: "#FFFCF2",
          "stock-night": "#ECE6D6",
          blue: "#0052FF",
          "blue-soft": "#7EA6FF",
          yellow: "#FFD60A",
          purple: "#9945FF",
          green: "#14F195",
          "green-ink": "#0B7A4B",
          red: "#FF5A5F",
          night: "#0B1120",
          "night-2": "#131E32",
          "night-3": "#1A2841",
          slate: "#4B5563",
          "slate-shadow": "#475569",
          muted: "#45464B",
          "muted-dark": "#A9B6C8",
        },
        // Semantic tokens (portal design 5.1): CSS variables on :root and
        // .dark in styles.css, so one class follows both themes
        // (bg-surface, text-fg, text-muted, border-control, outline-focus...).
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
      // Type scale with a 12 px floor (portal design 5.2). Anything a user must
      // read is at least `text-label` / `text-code-s` (0.75rem); smaller sizes
      // are for aria-hidden ornament only (site/ui/__tests__/typeFloor.test.mjs).
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
      },
      // Motion tokens (mirrored in src/app/site/motion/tokens.ts).
      transitionTimingFunction: {
        "kl-out": "var(--kl-ease-out)",
        "kl-standard": "var(--kl-ease-standard)",
        "kl-in": "var(--kl-ease-in)",
        "kl-snap": "var(--kl-ease-snap)",
      },
      transitionDuration: {
        90: "90ms",
        240: "240ms",
        420: "420ms",
      },
      // Site typography. The console keeps the default `sans`/`mono` system
      // stacks; these families are applied only inside the site shell
      // (font-display / font-body / font-code) and load with marketing routes.
      fontFamily: {
        display: ['"Space Grotesk Variable"', ...defaultTheme.fontFamily.sans],
        body: ['"Inter Variable"', ...defaultTheme.fontFamily.sans],
        code: ['"JetBrains Mono Variable"', ...defaultTheme.fontFamily.mono],
      },
    },
  },
  plugins: [],
};
