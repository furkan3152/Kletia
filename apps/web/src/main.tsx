// Must stay the first import: it installs EgressGuardV1 over the browser's
// outbound surfaces before any wallet SDK, transport or telemetry module can
// capture an unwrapped native reference. No production flow registers a
// private value yet, so today it watches nothing and blocks nothing
// (see the status note in shared/privacy/egressGuard.ts).
import "./shared/privacy/bootstrapEgressGuard";

import React from "react";
import ReactDOM from "react-dom/client";

import { enterDeskMode } from "./app/console/deskMode";
import { applyEmbedDocumentMode, readEmbedParams } from "./app/pages/embed/embedParams";
import { AppRouter } from "./app/router";
import { matchRoute } from "./app/routes/routeTable";
import { enterSiteMode } from "./app/site/theme";
import "./app/styles.css";

// Marketing routes and the desk (/app) scroll the document and follow the
// site theme; apply both before the first paint so there is no flash of a
// dark shell. The embed applies its own theme and (optional) transparent
// background.
const initialRouteKind = matchRoute(window.location.pathname.replace(/(.)\/+$/u, "$1")).kind;
if (initialRouteKind === "site") {
  enterSiteMode();
} else if (initialRouteKind === "console") {
  enterDeskMode();
} else if (initialRouteKind === "embed") {
  applyEmbedDocumentMode(readEmbedParams(window.location.search));
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppRouter />
  </React.StrictMode>,
);
