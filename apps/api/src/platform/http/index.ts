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
export { issueDeveloperKey, type IssuedApiKey } from "./auth.js";
export { WebhookDispatcher, httpsTransport, webhookDispatcherStats, type WebhookTransport, type DispatcherStats } from "./dispatcher.js";
export { isPublicAddress, assertPublicWebhookUrl } from "./netguard.js";
export { closePlatformDatabase } from "./db.js";
export { HttpError } from "./context.js";
