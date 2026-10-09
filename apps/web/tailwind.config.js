import defaultTheme from "tailwindcss/defaultTheme";

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
