/**
 * The Card machine's own icon drawings: a 24 px grid, 2 px round
 * stroke, currentColor. Networks, protocols, machine parts and UI. Not logos: they are drawn to
 * read as the network or venue without using its mark.
 *
 *   <Icon name="base" />                       decorative (aria-hidden)
 *   <Icon name="lock" label="Signed" />        meaningful (role="img")
 *   <g dangerouslySetInnerHTML={{ __html: ICON_PATHS.arb }} />   inside your own SVG (route art)
 */
import type { NetworkKey } from "@kletia/core";

export const ICON_PATHS = {
  // networks
  eth: '<path d="M12 2.5 5.5 12 12 21.5 18.5 12z"/><path d="M5.5 12 12 15l6.5-3M12 2.5V15"/>',
  base: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12H13"/>',
  arb: '<path d="M12 2.8 20 7.4v9.2l-8 4.6-8-4.6V7.4z"/><path d="M8.6 16 12 8.2 15.4 16"/>',
  op: '<circle cx="8" cy="12" r="4.3"/><path d="M15 17.5V7.5h2.6a3 3 0 0 1 0 6H15"/>',
  pol: '<path d="M2.8 9.6 7.4 7l4.6 2.6v4.8L7.4 17l-4.6-2.6z"/><path d="M12 9.6 16.6 7l4.6 2.6v4.8L16.6 17 12 14.4"/>',
  sol: '<path d="M7 6.5h13l-3 3H4zM4 10.5h13l3 3H7zM7 14.5h13l-3 3H4z" stroke-width="1.6"/>',
  arc: '<path d="M4 18a8 8 0 0 1 16 0"/><path d="M8 18a4 4 0 0 1 8 0"/><circle cx="12" cy="18" r="1.2" fill="currentColor"/>',
  // protocols
  across: '<path d="M5.5 5.5l13 13M18.5 5.5l-13 13"/><circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none"/>',
  uni: '<path d="M6 4.5V12a6 6 0 0 0 12 0V4.5"/><path d="M12 8.6c1.4 1.7 2.1 2.8 2.1 3.7a2.1 2.1 0 0 1-4.2 0c0-.9.7-2 2.1-3.7z" fill="currentColor" stroke="none"/>',
  relay: '<path d="M4 9h12.5l-3-3M20 15H7.5l3 3"/>',
  cctp: '<circle cx="12" cy="12" r="8.5"/><path d="M8 12h8m-3-3 3 3-3 3"/>',
  aave: '<path d="M5 19.5 12 5l7 14.5"/><circle cx="9.6" cy="15.2" r="1.1" fill="currentColor"/><circle cx="14.4" cy="15.2" r="1.1" fill="currentColor"/>',
  gmx: '<path d="M12 4 21 19.5H3z"/><path d="M12 11.2l3 5.2H9z" fill="currentColor"/>',
  jup: '<path d="M3.5 17a8.5 8.5 0 0 1 17 0M7 17a5 5 0 0 1 10 0"/><circle cx="12" cy="17" r="1.6" fill="currentColor"/>',
  aero: '<path d="M3 15.5 12 6.5l9 9-9-3.2z"/>',
  lido: '<path d="M12 3c3 4 5.6 6.8 5.6 10.2a5.6 5.6 0 0 1-11.2 0C6.4 9.8 9 7 12 3z"/><path d="M9 14.2h6"/>',
  poly: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 16v-3M12 16V9M15 16v-5"/>',
  hl: '<path d="M3 12c2.8-5 5.6-5 9 0s6.2 5 9 0"/>',
  // ui + machine parts
  desk: '<path d="M4 5.5h16v10H10l-4 3.5v-3.5H4z"/>',
  trade: '<path d="M7 4v16M17 4v16"/><rect x="5" y="8" width="4" height="7" rx="1" fill="currentColor"/><rect x="15" y="6" width="4" height="6" rx="1"/>',
  port: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  binder: '<rect x="6" y="3.5" width="13" height="17" rx="2"/><path d="M3.5 7v12.5a1.5 1.5 0 0 0 1.5 1.5h10"/><path d="M10 8.5h5M10 12h5"/>',
  auto: '<path d="M13 3 5 13.5h6L10 21l8-10.5h-6z"/>',
  more: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>',
  tasks: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3.5 6 1.5 1.5L7.5 5M3.5 12l1.5 1.5L7.5 11M3.5 18l1.5 1.5L7.5 17"/>',
  send: '<path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/>',
  snd: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4.5 4.5 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11"/>',
  mute: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="m16 9.5 5 5m0-5-5 5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/>',
  moon: '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>',
  replay: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.5v4.5H9"/>',
  shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.2 7.5 9.5 4.3-1.3 7.5-4.9 7.5-9.5V6z"/><path d="m9 12 2 2 4-4"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  swap: '<path d="M7 4v15M3.5 7.5 7 4l3.5 3.5M17 20V5M13.5 16.5 17 20l3.5-3.5"/>',
  bridge: '<path d="M3 17h18M5 17v-4M19 17v-4M3 10c3 3.5 15 3.5 18 0"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chev: '<path d="m7 10 5 5 5-5"/>',
  arr: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  flip: '<path d="M4 12a8 8 0 0 1 14-5.3L20 9M20 4.5V9h-4.5M20 12a8 8 0 0 1-14 5.3L4 15M4 19.5V15h4.5"/>',
  share: '<path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M5 13v6.5h14V13"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  gas: '<path d="M5 20V5.5A1.5 1.5 0 0 1 6.5 4h6A1.5 1.5 0 0 1 14 5.5V20M3.5 20h12M14 9.5h2a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 0 3 0V8l-3-3"/><path d="M7.5 7.5h4v3h-4z"/>',
  star: '<path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.9z"/>',
  sig: '<path d="M4 17c2.5 0 3.5-9 6-9s1 7 3.5 7S16 11 18 11s2 4 2 4"/><path d="M4 20.5h16"/>',
  perp: '<path d="M4 18 9.5 12l3.5 3.5L20 7.5"/><path d="M15 7.5h5v5"/>',
  ask: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.5a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .9-1 1.6v.6M12 17.2v.3"/>',
  earn: '<path d="M4 18.5h16M6 15V11M10 15V8M14 15v-5M18 15V5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  warn: '<path d="M12 3.5 21.5 20h-19z"/><path d="M12 10v4.5M12 17.2v.3"/>',
  wallet: '<rect x="3.5" y="6" width="17" height="13" rx="2.5"/><path d="M3.5 9.5h17M16 14h1.5"/>',
  pulse: '<path d="M3 12h4l2.5-6 5 12 2.5-6h4"/>',
  block: '<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/>',
  home: '<path d="M4 11 12 4l8 7v9H4z"/><path d="M10 20v-5h4v5"/>',
} as const;

export type IconName = keyof typeof ICON_PATHS;

/** The icon drawn for a network key (EVM testnets reuse their mainnet drawing). */
export function networkIcon(network: NetworkKey | string): IconName {
  if (network.startsWith("ethereum")) return "eth";
  if (network.startsWith("base")) return "base";
  if (network.startsWith("arbitrum")) return "arb";
  if (network.startsWith("optimism") || network.startsWith("op")) return "op";
  if (network.startsWith("polygon")) return "pol";
  if (network.startsWith("solana")) return "sol";
  if (network.startsWith("arc")) return "arc";
  return "block";
}

export interface IconProps {
  readonly name: IconName;
  /** Accessible name; omit for a decorative icon (aria-hidden). */
  readonly label?: string;
  readonly size?: number;
  readonly className?: string;
  readonly strokeWidth?: number;
}

export function Icon({ name, label, size, className, strokeWidth = 2 }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true, focusable: false })}
      dangerouslySetInnerHTML={{ __html: ICON_PATHS[name] }}
    />
  );
}

/**
 * The Kletia mark (public/kletia-logo.png) as a mask filled with currentColor, so it engraves on
 * the nameplate (ink by day, lime at night) at any size. Decorative.
 */
export function KletiaGlyph({ className, size }: { readonly className?: string; readonly size?: number }) {
  return <span aria-hidden="true" className={className ? `k-glyph ${className}` : "k-glyph"} style={size ? { width: size, height: size } : undefined} />;
}
