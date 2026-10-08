// Must stay the first import: it installs EgressGuardV1 over the browser's
// outbound surfaces before any wallet SDK, transport or telemetry module can
// capture an unwrapped native reference.
import "./shared/privacy/bootstrapEgressGuard";

import React from "react";
import ReactDOM from "react-dom/client";

import { AppRouter } from "./app/router";
import "./app/styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppRouter />
  </React.StrictMode>,
);
