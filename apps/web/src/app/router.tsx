import React from "react";

const ConsoleRoute = React.lazy(() => import("./routes/ConsoleRoute"));

function RouteFallback() {
  return (
    <div className="flex h-full items-center justify-center bg-[#0B1120] font-black uppercase tracking-widest text-white">
      Loading Kletia
    </div>
  );
}

/** Top-level router. Every route is code-split. */
export function AppRouter() {
  return (
    <React.Suspense fallback={<RouteFallback />}>
      <ConsoleRoute />
    </React.Suspense>
  );
}
