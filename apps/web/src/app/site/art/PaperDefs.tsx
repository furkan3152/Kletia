/**
 * Shared SVG filters, mounted once per page (SiteLayout):
 *   #kla-ink   rubber-stamp ink: a rough edge plus a few voids where the pad ran dry
 *   #kla-rough a slightly uneven printed edge, for large single shapes
 * Paper grain and halftone are CSS backgrounds, so nothing animates through
 * a filter. Never put an animated element inside a filtered group. Without
 * these defs a stamp simply prints clean.
 */
export function PaperDefs() {
  return (
    <svg
      width="0"
      height="0"
      aria-hidden="true"
      focusable="false"
      style={{ position: "absolute", width: 0, height: 0, overflow: "hidden", pointerEvents: "none" }}
    >
      <defs>
        <filter id="kla-ink" x="-8%" y="-8%" width="116%" height="116%" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves={2} seed={4} result="warp" />
          <feDisplacementMap in="SourceGraphic" in2="warp" scale={2.2} xChannelSelector="R" yChannelSelector="G" result="rough" />
          <feTurbulence type="fractalNoise" baseFrequency="0.7" numOctaves={2} seed={9} result="grain" />
          <feColorMatrix in="grain" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  -9 0 0 0 5.9" result="voids" />
          <feComposite in="rough" in2="voids" operator="in" />
        </filter>
        <filter id="kla-rough" x="-4%" y="-4%" width="108%" height="108%">
          <feTurbulence type="fractalNoise" baseFrequency="0.06" numOctaves={2} seed={2} result="warp" />
          <feDisplacementMap in="SourceGraphic" in2="warp" scale={1.6} xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </defs>
    </svg>
  );
}
