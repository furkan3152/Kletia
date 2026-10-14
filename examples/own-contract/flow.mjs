/**
 * The phase-2 path, no server of your own: store the registration as a
 * project flow, allow your page's origin, issue a publishable key and embed
 * it. The page then runs the flow with only the publishable key:
 *
 *   <kletia-intent key="kl_pub_…" flow="supply"></kletia-intent>
 *
 *   KLETIA_API_KEY=kl_dev_… CONTRACT_ID=ct_… PAGE_ORIGIN=https://shop.example node flow.mjs
 *
 * The flow is saved by your key: its call steps use your registrations (the
 * publishable key alone can never call a contract). Each visitor gets a
 * single-use 600 s session from the flow; the wallet signs, nothing here does.
 */
import { pathToFileURL } from "node:url";
import { KletiaClient } from "@kletia/sdk";

/** Saves `flowId` for the registration and returns the publishable key (shown once) and the snippet. */
export async function publishFlow(kletia, { contractId, network = "arbitrum-sepolia", entry = "supply", pageOrigin, flowId = "supply", label = "Supply USDC" }, log = console.log) {
  // Settings are merge-patched under If-Match: a concurrent change is never overwritten.
  const current = await kletia.projects.get();
  const origins = [...new Set([...(current.settings.allowedOrigins ?? []), pageOrigin])];
  const flows = [
    ...(current.settings.flows ?? []).filter((flow) => flow.id !== flowId),
    { id: flowId, label, actions: [{ kind: "call", network, contract: contractId, entry, amount: "10" }], amount: { action: 0, min: "1", max: "100" } },
  ];
  const project = await kletia.projects.update({ allowedOrigins: origins, flows }, { ifMatch: current.hash });
  log(`project: ${project.id} version ${project.version}; flow ${flowId} saved by ${project.settings.flows?.find((flow) => flow.id === flowId)?.ownerKeyId}`);
  const key = await kletia.projects.createPublishableKey({ label: "website" });
  log(`publishable key: ${key.id} (shown once; it works only from ${origins.join(", ")})`);
  const snippet = `<kletia-intent key="${key.key}" flow="${flowId}"></kletia-intent>`;
  return { project, key, snippet };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { KLETIA_API_KEY: apiKey, CONTRACT_ID: contractId, PAGE_ORIGIN: pageOrigin } = process.env;
  if (!apiKey || !contractId || !pageOrigin) {
    console.error("Usage: KLETIA_API_KEY=kl_dev_… CONTRACT_ID=ct_… PAGE_ORIGIN=https://shop.example node flow.mjs");
    process.exit(64);
  }
  const kletia = new KletiaClient({ apiKey, ...(process.env.KLETIA_BASE_URL ? { baseUrl: process.env.KLETIA_BASE_URL } : {}) });
  try {
    const { snippet } = await publishFlow(kletia, { contractId, pageOrigin });
    console.log(`\nPaste into your page (after the embed script):\n${snippet}`);
  } catch (error) {
    console.error(`${error.code ? `${error.code}: ` : ""}${error.message}`);
    process.exit(1);
  }
}
