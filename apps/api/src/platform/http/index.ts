/**
 * Public HTTP layer (Platform API v1). Mount with:
 *
 *   import { createPlatformRouter, platformErrorHandler, startPlatformBackground } from "./platform/http/index.js";
 *   app.use("/v1", createPlatformRouter(), platformErrorHandler);
 *   const stopPlatform = startPlatformBackground();
 */
export {
  createPlatformRouter,
  platformErrorHandler,
  startPlatformBackground,
  PLATFORM_ROUTES,
  MAX_BODY_BYTES,
  type PlatformBackgroundOptions,
  type PlatformRoute,
  type PlatformRouterOptions,
} from "./router.js";
export { buildOpenApiDocument, openApiJson } from "./openapi.js";
export { configureHealthProbe, readPlatformHealth, PLATFORM_API_VERSION, type NetworkHealth, type PlatformHealth } from "./health.js";
export { openStreamCount, TIER_LIMITS } from "./limits.js";
export { networkCapabilities, protocolRegistry, assetRegistry, type NetworkCapabilities } from "./catalog.js";
export { issueDeveloperKey, KEY_CACHE_TTL_MS, type IssuedApiKey } from "./auth.js";
export {
  listProjectKeys,
  revokeKey,
  rotateKey,
  MAX_ACTIVE_KEYS_PER_PROJECT,
  DEFAULT_ROTATION_GRACE_SECONDS,
  MAX_ROTATION_GRACE_SECONDS,
  type ApiKeyView,
  type RotatedApiKey,
} from "./keys.js";
export {
  idempotent,
  idempotencyUnsupported,
  MemoryIdempotencyStore,
  PostgresIdempotencyStore,
  IDEMPOTENCY_TTL_MS,
  type IdempotencyStore,
  type IdempotencyOptions,
} from "./idempotency.js";
export { errorCatalogView, errorDocsLink, type ErrorCatalogView } from "./errorsRoute.js";
export { kletiaWebOrigin } from "./webOrigin.js";
export {
  listDeliveries,
  sendTestDelivery,
  flushDeliveryLog,
  MemoryDeliveryStore,
  PostgresDeliveryStore,
  type DeliveryStore,
  type WebhookDelivery,
} from "./deliveries.js";
export { usageReport, flushUsage, MemoryUsageStore, PostgresUsageStore, type UsageReport, type UsageStore, type UsageWindow } from "./usage.js";
export { badgeStatus, badgeSvg, shieldsBadge, type BadgeStatus } from "./badge.js";
export { buildMcpServer, mcpHttpHandler, serveMcp } from "./mcp/server.js";
export { KLETIA_TOOLS, runTool, type KletiaTool, type ToolCaller } from "./mcp/tools.js";
export { signingLink, HANDOFF_MAX_TEXT, type SigningLink } from "./mcp/handoff.js";
export { assertMcpOrigin, allowedMcpOrigins } from "./mcp/origin.js";
export {
  WebhookDispatcher,
  httpsTransport,
  webhookDispatcherStats,
  webhookDeliveryTransport,
  type WebhookTransport,
  type DeliveryRecorder,
  type DispatcherStats,
} from "./dispatcher.js";
export { isPublicAddress, assertPublicWebhookUrl } from "./netguard.js";
export {
  installPreviewStore,
  IntentPreviewLimiter,
  PostgresPreviewStore,
  previewLimiter,
  PREVIEW_ACK_HEADER,
  PREVIEWS_PER_INTENT_PER_MINUTE,
  startPreviewPruner,
} from "./preview.js";
export {
  activeReceiptSigner,
  configureReceiptSigner,
  receiptKeys,
  receiptSignerStatus,
  resetReceiptKeyring,
  signerFromSeed,
  type ReceiptSigner,
  type ReceiptSignerStatus,
} from "./receipts/signer.js";
export { configureReceiptStore, MemoryReceiptStore, PostgresReceiptStore, receiptStore, type ReceiptStore, type StoredReceipt } from "./receipts/store.js";
export { enqueueReceipt, ReceiptIssuer, receiptIssuer, startReceiptIssuer, type ProcessOutcome, type ReceiptIssuerOptions } from "./receipts/issuer.js";
export { closeReceiptBatch, configureAnchorTransport, merkleTree, readEasTimestamp, reportAnchor, startReceiptLog, watchAnchors } from "./receipts/log.js";
export { decryptShare, encryptShare, parseShareUrl } from "./receipts/shares.js";
export { attestReceipt, verifyEasEnvelope, EAS_ADDRESS, EAS_SCHEMA, EAS_SCHEMA_UID, type EasEnvelope } from "./receipts/eas.js";
export { closePlatformDatabase } from "./db.js";
export { HttpError } from "./context.js";
