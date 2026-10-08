import { createServer } from "http";

import { app } from "./app.js";
import { PORT } from "../shared/config/serverRuntime.js";
import {
  enabledNetworkIds,
  readNetworkHealth,
} from "../shared/observability/networkHealth.js";

/**
 * Long-running server lifecycle (Render, Docker, local). Serverless hosts
 * import the app from index.ts and never call startServer().
 */

export const httpServer = createServer(app);

export async function assertRuntimeNetworkAttestation() {
  const checks = await Promise.all(
    enabledNetworkIds().map((network) =>
      readNetworkHealth(network, true),
    ),
  );
  // A chain-id mismatch means an RPC is pointed at the wrong network and is
  // always fatal. An unreachable RPC only degrades that network unless strict
  // startup is requested, so one provider outage cannot take the API down.
  const strict = process.env.KLETIA_STRICT_NETWORK_ATTESTATION?.trim() === "true";
  const failed = checks.filter(
    (check) =>
      check.status === "chain_mismatch" ||
      (strict && check.status !== "ok"),
  );
  if (failed.length > 0) {
    throw Object.assign(
      new Error(
        `Configured RPC chain attestation failed for ${failed
          .map(({ network }) => network)
          .join(", ")}.`,
      ),
      { code: "RPC_CHAIN_ATTESTATION_FAILED" },
    );
  }
  const degraded = checks.filter((check) => check.status === "unreachable");
  if (degraded.length > 0) {
    console.warn(
      `[startup] RPC unreachable, serving in degraded mode for: ${degraded
        .map(({ network }) => network)
        .join(", ")}.`,
    );
  }
  return checks;
}

export async function startServer() {
  if (httpServer.listening) return httpServer;
  const checks = await assertRuntimeNetworkAttestation();

  await new Promise<void>((resolve, reject) => {
    const onStartupError = (error: Error) => reject(error);
    httpServer.once("error", onStartupError);
    httpServer.listen(PORT, () => {
      httpServer.off("error", onStartupError);
      resolve();
    });
  });

  httpServer.on("error", (error: any) => {
    console.error("Server startup failed.", {
      name: error instanceof Error ? error.name : "UnknownError",
      code: typeof error?.code === "string" ? error.code : undefined,
    });
  });
  console.log(`Kletia API listening on port ${PORT}.`);
  console.log(
    `Attested networks: ${checks
      .filter(({ status }) => status === "ok")
      .map(({ network, chainId }) => `${network}:${chainId}`)
      .join(", ")}`,
  );
  return httpServer;
}

let shutdownStarted = false;
export function shutdownProcess(
  exitCode: number,
  reason: string,
  error?: unknown,
) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.error(`[PROCESS SHUTDOWN] ${reason}`, {
    name: error instanceof Error ? error.name : undefined,
    code:
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code || "")
        : undefined,
  });

  const exit = () => process.exit(exitCode);
  const forceExitTimer = setTimeout(exit, 5_000);
  forceExitTimer.unref();
  if (httpServer.listening) {
    httpServer.close(exit);
  } else {
    exit();
  }
}

export function installProcessHandlers() {
  process.once("SIGINT", () => shutdownProcess(0, "SIGINT"));
  process.once("SIGTERM", () => shutdownProcess(0, "SIGTERM"));
  process.once("uncaughtException", (error) =>
    shutdownProcess(1, "UNCAUGHT_EXCEPTION", error),
  );
  process.once("unhandledRejection", (reason) =>
    shutdownProcess(1, "UNHANDLED_REJECTION", reason),
  );
}
