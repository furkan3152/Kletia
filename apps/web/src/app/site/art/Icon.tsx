import "./base.css";

import { cx } from "../ui/styles";
import { ICON_PLATES, ICON_STROKES, type IconName } from "./icons";

export interface IconProps {
  readonly name: IconName;
  /** Rendered size in px (the drawing is on a 24 px grid). Default 24. */
  readonly size?: number;
  /** Print the second-ink plate (default true). Its colour is `--kla-plate`: yellow on paper, blue at night. */
  readonly plate?: boolean;
  /** Accessible name. Without it the icon is decorative (aria-hidden). */
  readonly title?: string;
  readonly className?: string;
}

/**
 * One of the 17 Kletia line icons: 2 px square-capped strokes in
 * currentColor, plus a solid plate printed slightly off register.
 */
export function Icon({ name, size = 24, plate = true, title, className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={cx("kla-icon", className)}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      focusable="false"
    >
      {plate ? <path className="kla-icon__plate" d={ICON_PLATES[name]} /> : null}
      <path
        d={ICON_STROKES[name]}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
    </svg>
  );
}
