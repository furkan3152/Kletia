import { cp, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = resolve(
  appRoot,
  "node_modules/stellar-private-payments",
);
const packageJson = JSON.parse(
  await readFile(resolve(packageRoot, "package.json"), "utf8"),
);

if (packageJson.version !== "0.1.0-alpha.1") {
  throw new Error(
    `Refusing to stage unreviewed stellar-private-payments ${String(packageJson.version)}.`,
  );
}

const source = resolve(packageRoot, "dist");
const destination = resolve(
  appRoot,
  "dist/vendor/stellar-private-payments/dist",
);
await cp(source, destination, { recursive: true, force: true });

const required = [
  "workers/storage-worker.js",
  "workers/storage-worker-module.js",
  "workers/storage-worker-module_bg.wasm",
  "workers/prover-worker.js",
  "workers/prover-worker-module.js",
  "workers/prover-worker-module_bg.wasm",
  "circuits/policy_tx_2_2_proving_key.bin",
  "circuits/policy_tx_2_2.wasm",
  "circuits/policy_tx_2_2.r1cs",
  "circuits/source-bundle.tar.gz",
  "circuits/NOTICE.txt",
  "licenses/LGPL-3.0.txt",
  "LICENSE.txt",
];

for (const relative of required) {
  const details = await stat(resolve(destination, relative));
  if (!details.isFile() || details.size === 0) {
    throw new Error(`Staged SPP artifact is missing or empty: ${relative}`);
  }
}

console.log(
  `Staged Stellar Private Payments ${packageJson.version} workers, circuits, notices and corresponding source.`,
);

