/**
 * Everything this page tells the widget, in one place (the checker's smoke
 * test reads it too).
 *
 * Kletia's API: the hosted one by default; set VITE_KLETIA_API_URL for a local
 * Kletia (`http://localhost:3000`). The widget calls the public tier: no key
 * ever reaches the browser.
 */
export const KLETIA_API_URL = import.meta.env?.VITE_KLETIA_API_URL || "https://api.kletiaai.xyz";

/** Appearance tokens: colours below their contrast floor fall back to safe ones; safety signage never changes. */
export const APPEARANCE = {
  colorScheme: "light",
  light: { accent: "#6D28D9", surface: "#FFFFFF", ink: "#1E1B4B" },
  dark: { accent: "#A78BFA", surface: "#17132B", ink: "#EDE9FE" },
  radius: 10,
  border: 2,
  shadow: "soft",
  font: "system",
  density: "comfortable",
};

/** This shop works with Base and Solana, and offers swaps and bridges: other plans are refused before Execute. */
export const NETWORKS = ["base", "solana"];
export const ACTIONS = ["swap", "bridge"];

export const EXAMPLES = ["swap 10 USDC to ETH on base", "bridge 25 USDC from base to solana", "swap 1 SOL to USDC"];
