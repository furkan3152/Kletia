/**
 * Side-effect-only bootstrap for EgressGuardV1.
 *
 * ES module imports are hoisted and evaluated before any statement in the
 * importing module's body runs. So calling `installEgressGuard()` from inside
 * `main.tsx` would install the guard *after* every dependency module has already
 * been evaluated, giving wallet SDKs, transports and telemetry a chance to
 * capture an unwrapped native `fetch` first.
 *
 * Importing this module as the very first import in the entrypoint installs the
 * guard during module evaluation, ahead of the rest of the import graph.
 */
import { installMemoryStorageFallback } from "../state/safeStorage";
import { installEgressGuard } from "./egressGuard";

// Blocked site data must not break boot; the guard then wraps the fallback too.
installMemoryStorageFallback();
installEgressGuard();
