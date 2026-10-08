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
