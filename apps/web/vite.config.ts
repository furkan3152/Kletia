import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // The entry includes the audited wallet-connector runtime. A separate
  // post-build budget checks both raw and gzip size; this limit keeps Vite's
  // generic warning aligned with that explicit release gate.
  build: {
    chunkSizeWarningLimit: 1_200,
  },
  server: {
    port: 5174,
  },
});
