const configuredBackendOrigin = import.meta.env.VITE_BACKEND_URL?.trim() || "";
const isProductionBuild = import.meta.env.PROD === true;
const allowLocalBackend =
  !isProductionBuild || import.meta.env.VITE_ALLOW_LOCAL_BACKEND === "true";
const candidate =
  configuredBackendOrigin ||
  (import.meta.env.DEV && allowLocalBackend ? "http://127.0.0.1:3001" : "");

if (!candidate) {
  throw new Error(
    "VITE_BACKEND_URL is required outside the explicit local development profile.",
  );
}

let parsedBackendUrl: URL;
try {
  parsedBackendUrl = new URL(candidate);
} catch {
  throw new Error("VITE_BACKEND_URL must be an absolute HTTP(S) origin.");
}

const localHostname =
  parsedBackendUrl.hostname === "localhost" ||
  parsedBackendUrl.hostname === "127.0.0.1" ||
  parsedBackendUrl.hostname === "[::1]";
if (
  !["http:", "https:"].includes(parsedBackendUrl.protocol) ||
  parsedBackendUrl.username ||
  parsedBackendUrl.password ||
  parsedBackendUrl.search ||
  parsedBackendUrl.hash ||
  (parsedBackendUrl.pathname !== "/" && parsedBackendUrl.pathname !== "")
) {
  throw new Error("VITE_BACKEND_URL must contain only a safe HTTP(S) origin.");
}
if (
  !allowLocalBackend &&
  (localHostname || parsedBackendUrl.protocol !== "https:")
) {
  throw new Error(
    "Production VITE_BACKEND_URL must be a non-local HTTPS origin.",
  );
}

export const BACKEND_URL = parsedBackendUrl.origin;
export const IS_LOCAL_BACKEND = localHostname;
export const BASE_PAYMASTER_ENABLED =
  import.meta.env.VITE_BASE_PAYMASTER_ENABLED === "true";
