// Entry point for every host. Vercel imports this module and serves the
// default-exported app; Render, Docker and `npm run dev` execute it directly,
// which also opens the port. Composition lives in http/app.ts, the server
// lifecycle in http/server.ts (both under http/, outside the paths Vercel scans
// for an Express entrypoint).
import "./shared/config/environment.js";
// Vercel's Express builder only accepts an entrypoint whose source imports the
// `express` package (it matches the import text). Express is already loaded by
// http/app.ts; this side-effect import keeps src/index.ts detectable.
import "express";
import { pathToFileURL } from "url";

import { app } from "./http/app.js";
import {
  assertRuntimeNetworkAttestation,
  httpServer,
  installProcessHandlers,
  shutdownProcess,
  startServer,
} from "./http/server.js";
import { allowedOrigins } from "./shared/http/cors.js";

const isDirectExecution =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectExecution) {
  installProcessHandlers();
  startServer().catch((error) => shutdownProcess(1, "STARTUP_FAILED", error));
}

// Vercel's Express runtime discovers a default-exported application. The
// direct-execution guard above preserves the long-running Render/local server
// path, while importing this module on Vercel never opens a port.
export default app;
export {
  allowedOrigins,
  app,
  assertRuntimeNetworkAttestation,
  httpServer,
  startServer,
};
