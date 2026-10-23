/** Class recipes shared by the desk's views (round 9); the components are in ViewParts.tsx. */
import { cx, CONTROL_BORDER, FOCUS_RING, INK_BORDER, SURFACE } from "../../site/ui/styles";

/** A bordered panel inside a view (a form, a list, a ticket). */
export const VIEW_PANEL = cx("flex min-w-0 flex-col gap-3 p-4", INK_BORDER, SURFACE);
export const PANEL_TITLE = "font-display text-lg font-bold";
/** Inputs and selects: the control border (3:1 in both themes) and the site focus ring. */
export const VIEW_FIELD = cx("min-h-11 w-full min-w-0 bg-surface px-3 text-base text-fg", CONTROL_BORDER, FOCUS_RING);
