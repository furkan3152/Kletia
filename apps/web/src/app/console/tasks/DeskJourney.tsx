/**
 * The desk's journey slot (console design 3.11): a dry-run plan's itinerary,
 * read only. Its prompts are asked once the plan is stored, in the review,
 * where `IntentExecutionFlow` renders the journey itself.
 */
import { JourneyPanel } from "../../site/intent/JourneyPanel";
import type { JourneySlotProps } from "./slots";

export function DeskJourney({ journey, intent }: JourneySlotProps) {
  if (!journey || journey.intentId !== intent.id) return null;
  return <JourneyPanel journey={journey} phase="review" />;
}

export default DeskJourney;
