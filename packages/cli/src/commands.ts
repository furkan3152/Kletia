/**
 * Command table for `kletia`. Every command is read-only or manages your
 * own keys, agent keys, rule books, approvals, webhooks, contract
 * registrations, sessions, receipt shares and intent links: the CLI never
 * prepares, signs or submits a transaction, and never holds funds.
 */
import type { Command } from "./common.js";
import { CONTRACT_COMMANDS } from "./contracts.js";
import { LISTEN_COMMANDS } from "./listen.js";
import { PROJECT_COMMANDS } from "./projects.js";
import { LINK_COMMANDS } from "./links.js";
import { POLICY_COMMANDS } from "./policies.js";
import { PREVIEW_COMMANDS } from "./preview.js";
import { RECEIPT_COMMANDS } from "./receipts.js";
import {
  assets,
  health,
  networks,
  protocols,
  quote,
  venues,
} from "./commands/catalog.js";
import { journeyCommand, plan, stop } from "./commands/plan.js";
import { intentsGet, intentsList, intentsWatch } from "./commands/intents.js";
import {
  keysCreate,
  keysList,
  keysRevoke,
  keysRotate,
} from "./commands/keys.js";
import {
  webhooksCreate,
  webhooksDelete,
  webhooksDeliveries,
  webhooksForward,
  webhooksList,
  webhooksTest,
  webhooksVerify,
} from "./commands/webhooks.js";
import { errors, openapi, usage } from "./commands/reference.js";

export { EXIT_ERROR, EXIT_INCONCLUSIVE, EXIT_INVALID, EXIT_MISMATCH, EXIT_NEEDS_INPUT, EXIT_NOT_COMPLETED, EXIT_OK, EXIT_USAGE } from "./common.js";
export type { Command, CommandContext } from "./common.js";
export { formatJourney } from "./commands/shared.js";

export const COMMANDS: readonly Command[] = Object.freeze([
  health,
  networks,
  protocols,
  assets,
  venues,
  quote,
  plan,
  journeyCommand,
  stop,
  intentsGet,
  intentsList,
  intentsWatch,
  ...PREVIEW_COMMANDS,
  ...RECEIPT_COMMANDS,
  keysCreate,
  keysList,
  keysRotate,
  keysRevoke,
  ...PROJECT_COMMANDS,
  ...POLICY_COMMANDS,
  webhooksList,
  webhooksCreate,
  webhooksDelete,
  webhooksTest,
  webhooksDeliveries,
  webhooksVerify,
  webhooksForward,
  ...LISTEN_COMMANDS,
  ...CONTRACT_COMMANDS,
  ...LINK_COMMANDS,
  usage,
  errors,
  openapi,
]);
