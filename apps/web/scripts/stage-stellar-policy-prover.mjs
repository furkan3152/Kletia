import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appRoot, "../..");
const artifacts = [
  {
    source: resolve(
      repoRoot,
      "circuits/stellar-policy/build/KletiaPolicyV1_js/KletiaPolicyV1.wasm",
    ),
    destination: resolve(appRoot, "dist/vendor/kletia-policy-v1/KletiaPolicyV1.wasm"),
    sha256: "cfbab54334c76342d0ca35ebcc77dc40b31f6aceafce8c4c326afb6f209d03ea",
    releaseUrlEnvironmentVariable: null,
    maximumBytes: 16 * 1024 * 1024,
  },
  {
    source: resolve(
      repoRoot,
      "circuits/stellar-policy/build/testnet-deployment/kletia_policy_testnet_final.zkey",
    ),
    destination: resolve(appRoot, "dist/vendor/kletia-policy-v1/kletia_policy_testnet_final.zkey"),
    sha256: "bfa4570c88e05ac9d1146983e8cd84bf9ac7a378d9d2914a1b0975382bf8ee56",
    releaseUrlEnvironmentVariable: null,
    maximumBytes: 64 * 1024 * 1024,
  },
  {
    source: resolve(
      repoRoot,
      "circuits/stellar-policy/build-v2/KletiaPolicyV2_js/KletiaPolicyV2.wasm",
    ),
    destination: resolve(appRoot, "dist/vendor/kletia-policy-v2/KletiaPolicyV2.wasm"),
    sha256: "f13d9dc4e1ee86fd432a45d9696c91122d8beef3906687acb6a84d1b311115a5",
    releaseUrlEnvironmentVariable: "STELLAR_POLICY_V2_PROVER_WASM_RELEASE_URL",
    maximumBytes: 16 * 1024 * 1024,
  },
  {
    source: resolve(
      repoRoot,
      "circuits/stellar-policy/build-v2/testnet-deployment/kletia_policy_v2_testnet_final.zkey",
    ),
    destination: resolve(appRoot, "dist/vendor/kletia-policy-v2/kletia_policy_v2_testnet_final.zkey"),
    sha256: "797054251bab3165a7cdc868d81027b306462e9e181c97db8ec4238344d2b52a",
    releaseUrlEnvironmentVariable: "STELLAR_POLICY_V2_PROVING_KEY_RELEASE_URL",
    maximumBytes: 64 * 1024 * 1024,
  },
];

async function localBytes(path) {
  try {
    await access(path);
    return await readFile(path);
  } catch {
    return null;
  }
}

function immutablePublicReleaseUrl(environmentVariable) {
  const raw = process.env[environmentVariable]?.trim();
  if (!raw) return null;
  const parsed = new URL(raw);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      `${environmentVariable} must be a public immutable HTTPS URL without credentials, query parameters or a fragment.`,
    );
  }
  return parsed.toString();
}

async function releaseBytes(artifact) {
  const local = await localBytes(artifact.source);
  if (local) return { bytes: local, source: "local_pinned_artifact" };
  if (!artifact.releaseUrlEnvironmentVariable) return null;
  const url = immutablePublicReleaseUrl(artifact.releaseUrlEnvironmentVariable);
  if (!url) return null;
  const response = await fetch(url, {
    method: "GET",
    cache: "no-store",
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(
      `${artifact.releaseUrlEnvironmentVariable} returned HTTP ${response.status}.`,
    );
  }
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (declaredLength > artifact.maximumBytes) {
    throw new Error(`${artifact.releaseUrlEnvironmentVariable} exceeds its release size limit.`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > artifact.maximumBytes) {
    throw new Error(`${artifact.releaseUrlEnvironmentVariable} has an invalid release size.`);
  }
  return { bytes, source: "immutable_public_release" };
}

const staged = [];
const unavailable = [];
for (const artifact of artifacts) {
  const release = await releaseBytes(artifact);
  if (!release) {
    await rm(artifact.destination, { force: true });
    unavailable.push(artifact);
    continue;
  }
  const { bytes } = release;
  const observed = createHash("sha256").update(bytes).digest("hex");
  if (observed !== artifact.sha256) {
    throw new Error(
      `Refusing to stage drifted Stellar policy artifact; expected ${artifact.sha256}, observed ${observed}.`,
    );
  }
  await mkdir(dirname(artifact.destination), { recursive: true, mode: 0o755 });
  const temporary = `${artifact.destination}.tmp-${process.pid}`;
  await writeFile(temporary, bytes, { mode: 0o644 });
  await rename(temporary, artifact.destination);
  staged.push({
    file: artifact.destination.slice(appRoot.length + 1),
    sha256: artifact.sha256,
    bytes: bytes.length,
    source: release.source,
  });
}

const v2Artifacts = staged.filter((entry) => entry.file.includes("kletia-policy-v2/"));
const v2Directory = resolve(appRoot, "dist/vendor/kletia-policy-v2");
if (v2Artifacts.length === 2) {
  await mkdir(v2Directory, { recursive: true, mode: 0o755 });
  await writeFile(
    resolve(v2Directory, "release-manifest.json"),
    `${JSON.stringify({
      schemaVersion: "kletia_policy_v2_browser_release_v1",
      network: "stellar_testnet",
      trustedSetupProfile: "testnet_development_single_contributor",
      productionReady: false,
      artifacts: v2Artifacts,
    }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o644 },
  );
} else {
  await rm(resolve(v2Directory, "release-manifest.json"), { force: true });
}

if (unavailable.length > 0) {
  console.warn(
    `Stellar policy prover staging left ${unavailable.length} artifact(s) unavailable. ` +
    "Affected policy-proof controls remain capability-disabled; no placeholder artifact was generated.",
  );
}
console.log(`Staged ${staged.length} hash-pinned Stellar Testnet policy prover artifact(s).`);
