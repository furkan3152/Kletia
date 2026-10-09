import "./base.css";
import "./map.css";

import type { ReactNode } from "react";

import { cx } from "../ui/styles";
import { CropMarks } from "./Ornaments";
import { RouteMap } from "./RouteMap";

export interface MapCardProps {
  readonly children: ReactNode;
  /**
   * The printer's slug line (map number, edition, "Not to scale"), printed
   * outside the trim above the top-right corner, where nothing laid over the
   * card can cover it.
   */
  readonly slug?: ReactNode;
  /**
   * Leave a blank, dashed-ruled margin under the map so a ticket can be laid
   * over the bottom edge of the card without covering the drawing.
   */
  readonly margin?: boolean;
  readonly className?: string;
}

/**
 * The folded paper a map is printed on: grain, two fold creases, crop marks,
 * a process colour bar and a slug line outside the trim. The creases sit under
 * the drawing, so they never wash out a label. Leave about 30 px around the
 * card for the marks.
 */
export function MapCard({ children, slug, margin = false, className }: MapCardProps) {
  return (
    <div className={cx("kla-mapcard", className)}>
      <CropMarks colorBar />
      {slug ? <div className="kla-mapcard__slug">{slug}</div> : null}
      {children}
      {margin ? <div aria-hidden="true" className="kla-mapcard__margin" /> : null}
    </div>
  );
}

export interface RouteMapCardProps {
  /** Slug line above the top-right corner (see MapCard); dropped on the strip. */
  readonly slug?: ReactNode;
  /** Blank bottom margin for a ticket laid over the card (see MapCard). */
  readonly margin?: boolean;
  /** Draw in and run the train (ignored with reduced motion). Default true. */
  readonly animate?: boolean;
  /** Hide both maps from assistive tech when the page says the same in text. */
  readonly decorative?: boolean;
  readonly className?: string;
}

/**
 * The hero map on its card. Measures its own width: the full map from 600 px
 * of card width, the Base to Solana strip below that (the slug and the
 * margin are dropped on the strip). Only the visible map is exposed to
 * assistive tech.
 */
export function RouteMapCard({ slug, margin = false, animate = true, decorative = false, className }: RouteMapCardProps) {
  return (
    <div className={cx("kla-mapcard-host", className)}>
      <MapCard slug={slug} margin={margin} className="kla-mapcard--responsive">
        <RouteMap variant="full" animate={animate} decorative={decorative} />
        <RouteMap variant="strip" animate={animate} decorative={decorative} />
      </MapCard>
    </div>
  );
}
