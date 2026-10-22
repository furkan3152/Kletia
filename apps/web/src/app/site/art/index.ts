/**
 * Catalogue of the Kletia art system ("Interchange"): types and pure helpers.
 *
 * Components are NOT re-exported here. Import each one from its own module
 * (`site/art/Ticket`, `site/art/DepartureBoard`, ...): every component
 * imports its own stylesheet, and an ES import runs every module it names, so
 * a barrel that re-exported components would load all of their CSS into any
 * page chunk that used one of them (measured with Vite: importing Icon through
 * such a barrel shipped 36 KB of CSS instead of 3.4 KB). Type exports are
 * erased at build time, so the prop types are safe to take from here.
 *
 * Module map:
 *   Icon, LineBullet, Stamp, PaperDefs            ./Icon, ./LineBullet, ./Stamp, ./PaperDefs
 *   RouteMap / MapCard, RouteMapCard              ./RouteMap, ./MapCard
 *   Ticket, TicketStub, BlankTicket               ./Ticket
 *   LinkTicket / TicketShell                      ./LinkTicket, ./TicketShell
 *   DepartureBoard                                ./DepartureBoard
 *   PlatformNumber, LineRule, TrackDivider,
 *   Perforation, CropMarks, HalftoneEdge          ./Ornaments
 *   PlatformSign, SpecSheet, EndOfLine            ./PlatformSign, ./SpecSheet, ./EndOfLine
 *   LineStrip (the in-car strip map)              ./LineStrip
 *   JourneyMap, CertaintyGlyph (the itinerary)    ./JourneyMap
 */

export type { BoardRow, DepartureBoardProps } from "./DepartureBoard";
export type { EndOfLineProps } from "./EndOfLine";
export type { IconProps } from "./Icon";
export type { JourneyMapProps } from "./JourneyMap";
export type { LineBulletProps } from "./LineBullet";
export type { LineStripProps, StripStop } from "./LineStrip";
export type { LinkBound, LinkPublisher, LinkTicketProps } from "./LinkTicket";
export type { MapCardProps, RouteMapCardProps } from "./MapCard";
export type { CropMarksProps, LineRuleProps, PlatformNumberProps, TrackDividerProps } from "./Ornaments";
export type { PlatformSignProps, Service } from "./PlatformSign";
export type { RouteMapProps } from "./RouteMap";
export type { StampProps } from "./Stamp";
export type { BlankTicketProps, TicketLeg, TicketProps, TicketStubProps } from "./Ticket";
export type { TicketField, TicketHeadProps, TicketShellProps } from "./TicketShell";

export {
  boardName,
  boardStatus,
  DELAYED_ABOVE_MS,
  describeLatency,
  formatBoardClock,
  formatLatency,
  STATUS_FLAPS,
  STATUS_SPEECH,
  type BoardStatus,
} from "./boardFormat";
export { contrastRatio, readableOn, relativeLuminance } from "./color";
export {
  countdownText,
  CUSTODY_STAMPS,
  custodyStamp,
  etaText,
  horizontalFrom,
  indicativeFacts,
  isOverdue,
  JOURNEY_HORIZONTAL_MIN_PX,
  JOURNEY_MAX_HORIZONTAL_STOPS,
  JOURNEY_STATION_MIN_PX,
  journeyAnnouncement,
  journeyLayout,
  legDrawing,
  legLeaving,
  placeOf,
  whereMoneyIs,
  type JourneyLayout,
  type JourneyOrientation,
  type LegDrawing,
  type MoneyLine,
} from "./journeyFormat";
export { categoryIcon, categoryWord, ICON_NAMES, isIconName, type IconName } from "./icons";
export { STAMP_LABELS, STAMP_SENTENCES, STAMP_STATES, type StampState } from "./stampText";
export { countOf, legNumber, shortHash } from "./ticketFormat";
export {
  BLUE,
  bulletCode,
  INK,
  INTERCHANGE_VENUES,
  lineFor,
  lineOf,
  LINES,
  PAPER,
  PRODUCTION_LINES,
  STOCK,
  venueOn,
  YARD_LINES,
  YELLOW,
  type Gauge,
  type Line,
} from "./tokens";
