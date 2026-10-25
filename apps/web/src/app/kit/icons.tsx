/**
 * The Card machine's own icon drawings: a 24 px grid, 2 px round
 * stroke, currentColor. Networks, protocols, machine parts and UI. Not logos: they are drawn to
 * read as the network or venue without using its mark.
 *
 *   <Icon name="base" />                       decorative (aria-hidden)
 *   <Icon name="lock" label="Signed" />        meaningful (role="img")
 *   <g dangerouslySetInnerHTML={{ __html: ICON_PATHS.arb }} />   inside your own SVG (route art)
 */
import { ICON_PATHS, type IconName } from "./iconPaths";

export type { IconName };

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
