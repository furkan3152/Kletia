/**
 * `@kletia/widget/review`: pure, React-free helpers that turn what Kletia
 * returns before a signature into display data. The widget renders them in
 * its own design system and the Kletia web app (Studio, `/embed`) in the
 * Interchange one, so both say the same thing:
 *
 * - `fareModel`: the intent-level asset-change preview ("fare breakdown"):
 *   what you pay, what you get (expected and at least), what passes through
 *   your wallets, fees in USD, allowances, what your wallets must hold (gas
 *   on arrival) and a certainty label on every number.
 * - `contractReviewModel`: the review of a custom-contract (`call` /
 *   `action`) step, in the order who, what, permissions, result,
 *   provenance, notice, and whether signing needs an explicit
 *   acknowledgement.
 * - `policyHold` / `policyRefusal`: Rule Book outcomes (held for approval,
 *   refused) with the rule ids and a safe approval link.
 * - Receipt share profiles and link checks.
 * - `journeyModel`: the journey ledger (where the money is after every step,
 *   what follows, which questions block the next signature), with
 *   `SEVERITY_SIGNS` for its notices.
 * - `clarifyView` / `journeyPromptView`: clarifying questions and journey
 *   prompts as one question card, and `AssumptionChips` data.
 *
 * Everything integrators or venues control (names, websites, labels,
 * arguments, URLs) is returned as plain text for text nodes, cleaned of
 * control and bidirectional-override characters, and links are only ever
 * returned for https URLs of the expected shape.
 *
 * The modules live in ./review/.
 */
export {
  CERTAINTY_INFO,
  cleanText,
  formatUsdAbs,
  httpsUrl,
  isHttpsUrl,
  networkLabel,
  shortAddress,
  unsignedAmount,
} from "./review/text.js";
export type { CertaintyInfo, CertaintyShape } from "./review/text.js";
export * from "./review/fare.js";
export * from "./review/contract.js";
export * from "./review/policy.js";
export * from "./review/receiptShare.js";
export * from "./review/journey.js";
export * from "./review/clarify.js";
