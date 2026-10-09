import "./base.css";
import "./map.css";

import type { ReactNode } from "react";

import { cx } from "../ui/styles";
import { CropMarks } from "./Ornaments";
import { RouteMap } from "./RouteMap";

export interface MapCardProps {
  readonly children: ReactNode;
  /** A printed strip under the map, right-aligned (title block: map number, date, "Not to scale"). */
  readonly foot?: ReactNode;
  readonly className?: string;
}

/**
 * The folded paper a map is printed on: grain, two fold creases, crop marks
 * and a process colour bar. The creases sit under the drawing, so they never
 * wash out a label. Leave about 30 px around the card for the crop marks.
 */
export function MapCard({ children, foot, className }: MapCardProps) {
  return (
    <div className={cx("kla-mapcard", className)}>
      <CropMarks colorBar />
      {children}
      {foot ? <div className="kla-mapcard__foot">{foot}</div> : null}
    </div>
  );
}

export interface RouteMapCardProps {
  readonly foot?: ReactNode;
  /** Draw in and run the train (ignored with reduced motion). Default true. */
  readonly animate?: boolean;
  /** Hide both maps from assistive tech when the page says the same in text. */
  readonly decorative?: boolean;
  readonly className?: string;
}

/**
 * The hero map on its card. Measures its own width: the full map from 600 px
 * of card width, the Base to Solana strip below that (the foot is dropped on
 * the strip). Only the visible map is exposed to assistive tech.
 */
export function RouteMapCard({ foot, animate = true, decorative = false, className }: RouteMapCardProps) {
  return (
    <div className={cx("kla-mapcard-host", className)}>
      <MapCard foot={foot} className="kla-mapcard--responsive">
        <RouteMap variant="full" animate={animate} decorative={decorative} />
        <RouteMap variant="strip" animate={animate} decorative={decorative} />
      </MapCard>
    </div>
  );
}
