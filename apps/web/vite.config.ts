import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    include: ["buffer"],
  },
  // Wallet runtimes load lazily with the console route. A separate
  // post-build budget checks both raw and gzip size of the entry; this limit
  // keeps Vite's generic warning aligned with that explicit release gate.
  build: {
    chunkSizeWarningLimit: 1_200,
  },
  server: {
    port: 5174,
    fs: {
      // Workspace packages (@kletia/core, @kletia/sdk) are linked from ../../packages.
      allow: [".", "../../packages"],
    },
  },
});
