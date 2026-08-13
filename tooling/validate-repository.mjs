import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const fail = (message) => {
  console.error(`Repository structure check failed: ${message}`);
  process.exitCode = 1;
};

const gitFilesResult = spawnSync("git", ["ls-files", "-z"], {
  encoding: "utf8",
});
if (gitFilesResult.status !== 0) {
  throw new Error("Unable to read the tracked repository manifest.");
}

const trackedFiles = gitFilesResult.stdout.split("\0").filter(Boolean);
const tracked = new Set(trackedFiles);
const requiredFiles = [
  "apps/api/package.json",
  "apps/web/package.json",
  "contracts/base/package.json",
  "contracts/arc/package.json",
  "apps/api/src/networks/base/protocols.ts",
  "apps/api/src/networks/arc/routes.ts",
  "apps/web/src/networks/base/x402/baseX402Buyer.ts",
  "apps/web/src/networks/arc/config.ts",
  "contracts/base/contracts/v2/core/KletiaIntentRouterV2.sol",
  "contracts/arc/contracts/KletiaArcSwap.sol",
  "render.yaml",
  "attachments/GASOK_Team_Archial.md",
  "attachments/Kletia_Arc_Submission.pdf",
  "attachments/Kletia_Programmable_Money_Submission.pdf",
  "attachments/genctek.jpg",
  "attachments/one_pager.html",
  "attachments/pitch.html",
  "attachments/pitch_deck.html",
];

const attachmentHashes = {
  "attachments/GASOK_Team_Archial.md":
    "bd2764f97861dc91e82ef89eacf19cd0bdd93813f76b8bf0813f97afc3941ea5",
  "attachments/Kletia_Arc_Submission.pdf":
    "df6e24a60d775856f42bf6c7f5994203f6106d604d25dc37fa1deef27398cd34",
  "attachments/Kletia_Programmable_Money_Submission.pdf":
    "8a0c168c3d70ffef712ca3bd7ed34b826466cf65d2b8c91587a7d635e9d9ea4f",
  "attachments/genctek.jpg":
    "f14abe63deb26436b136a1c4bd236356f5e2a5b7b5a2a19f646cd07af9aacab9",
  "attachments/one_pager.html":
    "7eb6edcc6e96a393bdfa600c64726d98360b8996fd719dd92f24ecb3143f2325",
  "attachments/pitch.html":
    "dae4a6d7b77448d69a5a18ae4bb992d368f06dccef7aeaef013c215897058ae5",
  "attachments/pitch_deck.html":
    "d31379d26865ea464eb3ec9654ed5939ff6560013f641fb797e78f4ab7d1e934",
};

for (const file of requiredFiles) {
  if (!tracked.has(file)) fail(`required tracked file is missing: ${file}`);
}

for (const [file, expectedHash] of Object.entries(attachmentHashes)) {
  const actualHash = createHash("sha256")
    .update(readFileSync(file))
    .digest("hex");
  if (actualHash !== expectedHash)
    fail(`path-stable attachment changed: ${file}`);
}

for (const prefix of ["backend/", "frontend/", "smart-contracts/"]) {
  const stale = trackedFiles.find((file) => file.startsWith(prefix));
  if (stale) fail(`deprecated package path is still tracked: ${stale}`);
}

const staleSourcePrefixes = [
  "apps/api/src/agent/",
  "apps/api/src/bridge/",
  "apps/api/src/creator/",
  "apps/api/src/dex/",
  "apps/api/src/lending/",
  "apps/api/src/portfolio/",
  "apps/api/src/staking/",
  "apps/web/src/arc/",
  "apps/web/src/x402/",
];
for (const prefix of staleSourcePrefixes) {
  const stale = trackedFiles.find((file) => file.startsWith(prefix));
  if (stale) fail(`network-owned source is outside its boundary: ${stale}`);
}

for (const file of trackedFiles) {
  if (
    (file.startsWith("apps/api/src/") || file.startsWith("apps/web/src/")) &&
    /\/[a-z0-9]+_[a-z0-9_]+\.(?:ts|tsx)$/u.test(file)
  ) {
    fail(`source filename must use camelCase or PascalCase: ${file}`);
  }
}

const generatedSegment = /\/(?:artifacts|cache|dist|node_modules)\//u;
for (const file of trackedFiles) {
  if (generatedSegment.test(`/${file}`)) {
    fail(`generated output must not be tracked: ${file}`);
  }
}

const packageNames = [
  "apps/api/package.json",
  "apps/web/package.json",
  "contracts/base/package.json",
  "contracts/arc/package.json",
].map((file) => JSON.parse(readFileSync(file, "utf8")).name);
if (new Set(packageNames).size !== packageNames.length) {
  fail("package names must be unique");
}

for (const file of trackedFiles) {
  if (
    file.startsWith("contracts/base/contracts/") &&
    /\/KletiaArc[^/]*\.sol$/u.test(file)
  ) {
    fail(`Arc contract is stored in the Base package: ${file}`);
  }
  if (
    file.startsWith("contracts/arc/contracts/") &&
    /\/(?:X402Factory|X402Gateway|KletiaGIWARouter)\.sol$/u.test(file)
  ) {
    fail(`Base-only contract is stored in the Arc package: ${file}`);
  }
}

const renderConfig = readFileSync("render.yaml", "utf8");
for (const root of ["rootDir: apps/api", "rootDir: apps/web"]) {
  if (!renderConfig.includes(root)) fail(`Render root is missing: ${root}`);
}

if (!process.exitCode) {
  console.log("Repository structure check passed.");
}
