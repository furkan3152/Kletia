/**
 * Fills the desk's slots once, when the desk's task modules load: the
 * journey slot shows a dry-run plan's itinerary and the question slot the
 * task's clarify question. Journey prompts never go to the question slot.
 */
import { DeskJourney } from "./DeskJourney";
import { QuestionSlot } from "./QuestionSlot";
import { registerDeskSlots } from "./slots";

let registered = false;

/** Registers the desk's slot components (idempotent). */
export function registerDeskTaskSlots(): void {
  if (registered) return;
  registered = true;
  registerDeskSlots({ Journey: DeskJourney, Question: QuestionSlot });
}
