// Smart Account Kit 0.6.2 was built and deployed with Stellar SDK 16.0.1.
// Keep that exact runtime isolated from Kletia's SDK 17 application surface.
// Vite pre-bundles the npm alias behind this shim so the SDK's CommonJS
// transitive dependencies are normalized for the browser.
export * from "stellar-sdk-16";
