import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

function smartAccountKitSdkCompatibility(): Plugin {
  const smartAccountPackage = /\/node_modules\/(?:smart-account-kit|smart-account-kit-bindings)\//u;
  const sdk16Shim = fileURLToPath(
    new URL("./src/vendor/smartAccountKitStellarSdk.ts", import.meta.url),
  );
  const sdk16ContractShim = fileURLToPath(
    new URL("./src/vendor/smartAccountKitStellarContract.ts", import.meta.url),
  );
  const sdk16RpcShim = fileURLToPath(
    new URL("./src/vendor/smartAccountKitStellarRpc.ts", import.meta.url),
  );
  return {
    name: "kletia-smart-account-kit-sdk-compatibility",
    enforce: "pre",
    async resolveId(source, importer) {
      if (!importer || !smartAccountPackage.test(importer)) {
        return null;
      }
      if (source === "@stellar/stellar-sdk") return sdk16Shim;
      if (source === "@stellar/stellar-sdk/contract") return sdk16ContractShim;
      if (source === "@stellar/stellar-sdk/rpc") return sdk16RpcShim;
      return null;
    },
  };
}

export default defineConfig({
  plugins: [smartAccountKitSdkCompatibility(), react()],
  optimizeDeps: {
    exclude: ["smart-account-kit", "smart-account-kit-bindings"],
    include: [
      "buffer",
      "base64url",
      "stellar-sdk-16",
      "stellar-sdk-16/contract",
      "stellar-sdk-16/rpc",
    ],
  },
  // The isolated Groth16 worker lazy-loads the prover so the main application
  // does not pay its parse cost. ES output is required for worker code-splitting.
  worker: {
    format: "es",
  },
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
