/**
 * The desk's journey slot (console design 3.11): a dry-run plan's itinerary,
 * read only. Its prompts are asked once the plan is stored, in the review,
 * where `IntentExecutionFlow` renders the journey itself.
 */
import { JourneyPanel } from "../../site/intent/JourneyPanel";
import { labelDemoJourney } from "./demoAccounts";
import type { JourneySlotProps } from "./slots";

export function DeskJourney({ journey, intent }: JourneySlotProps) {
  if (!journey || journey.intentId !== intent.id) return null;
  // Before a wallet is connected the plan uses demo accounts: they are labelled as such, never "Your wallet".
  return <JourneyPanel journey={labelDemoJourney(journey)} phase="review" />;
}
