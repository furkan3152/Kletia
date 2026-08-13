import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(packageRoot, "dist");

if (dirname(outputDirectory) !== packageRoot) {
  throw new Error("Refusing to clean an output directory outside apps/api.");
}

rmSync(outputDirectory, { recursive: true, force: true });
