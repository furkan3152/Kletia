/**
 * The portfolio assistant (docs/platform/assistant.md): questions about a
 * person's own wallets answered from the data API, portfolio requests turned
 * into sentences for the normal plan, confirm and sign flow.
 */
export { ask, EXAMPLE_QUESTIONS, refusalOf, walletLabels, type AskInput } from "./service.js";
export {
  assistantTransaction,
  dataApiPort,
  dataApiReader,
  HISTORY_READ,
  TRACKING_OFF,
  type AssistantDataPort,
  type AssistantDataReader,
  type AssistantPnl,
  type AssistantPnlRow,
  type AssistantSummary,
  type AssistantTransaction,
  type AssistantTransactions,
  type HistoryAccess,
} from "./dataPort.js";
export { checkGrounding } from "./grounding.js";
export { assistantModel, AssistantModel, assistantModelConfigFromEnv, configureAssistantModel, type AssistantModelConfig } from "./model.js";
