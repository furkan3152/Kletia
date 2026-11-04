/**
 * The line tickets print in their products' own type: Pixelify Sans,
 * Silkscreen and IBM Plex Mono (Elyia, Pixel Survey), and Space Grotesk with
 * the pixel faces (Lykia, Mosaic). They load only when a ticket mounts (the
 * network routes), from Google Fonts like the site's own type, with
 * font-display: swap and a monospace fallback in every stack.
 */
export const NETWORK_FONTS_HREF =
  "https://fonts.googleapis.com/css2?display=swap&family=Pixelify+Sans:wght@500;700&family=Silkscreen&family=IBM+Plex+Mono:wght@400;600&family=Space+Grotesk:wght@400;600";

const MARKER = "data-kletia-network-fonts";

/** Adds the stylesheet once per document. */
export function loadNetworkFonts(doc: Document | undefined = typeof document === "undefined" ? undefined : document): void {
  if (!doc?.head || doc.head.querySelector(`link[${MARKER}]`)) return;
  const link = doc.createElement("link");
  link.rel = "stylesheet";
  link.href = NETWORK_FONTS_HREF;
  link.setAttribute(MARKER, "");
  doc.head.appendChild(link);
}
