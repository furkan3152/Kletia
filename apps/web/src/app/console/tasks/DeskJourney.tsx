/**
 * The desk's journey slot: a dry-run plan's itinerary, read only. Its
 * prompts are asked once the plan is stored, in the review, where
 * `IntentExecutionFlow` renders the journey itself.
 */
import { JourneyPanel } from "../../site/intent/JourneyPanel";
import { labelDemoJourney } from "./demoAccounts";
import type { JourneySlotProps } from "./slots";

export function DeskJourney({ journey, intent }: JourneySlotProps) {
  if (!journey || journey.intentId !== intent.id) return null;
  // Before a wallet is connected the plan uses demo accounts: they are labelled as such, never "Your wallet".
  // The card draws the route; the stop-by-stop itinerary folds under it.
  return (
    <details className="kd-memory">
      <summary>Where the money is after each step</summary>
      <JourneyPanel journey={labelDemoJourney(journey)} phase="review" />
    </details>
  );
}
