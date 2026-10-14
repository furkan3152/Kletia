/**
 * Register your own contract, testnet first: inspect → validate → register →
 * test, then print the review your users will see before they sign.
 * Nothing is signed: `contracts.test` plans, prepares and simulates only.
 *
 *   KLETIA_API_KEY=kl_dev_… node register.mjs contract.arbitrum-sepolia.json --account 0xYourWallet
 *
 * On a testnet the registration is active at once; on mainnet it is
 * pending until `activatesAt` (sessions created meanwhile carry a
 * CONTRACT_PENDING warning).
 */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { formatAccountId, KletiaClient } from "@kletia/sdk";
import { validateContractDefinition } from "@kletia/core";

/** The four steps, with a client you configure (the smoke check passes a stub's). */
export async function registerAndTest(kletia, definition, address, log = console.log) {
  // 1. What registering would pin and allow (and, for an ERC-4626 vault, its asset).
  const inspection = await kletia.contracts.inspect({ network: definition.network, address: definition.address });
  if (inspection.vm !== "evm" || inspection.denied || !inspection.deployed) {
    throw new Error(`${definition.network}:${definition.address} cannot be registered: ${inspection.denied ?? "no contract code there"}`);
  }
  log(`inspect: code ${inspection.pins?.codeHash ?? "?"}${inspection.pins?.proxy ? ` (${inspection.pins.proxy.kind} proxy)` : ""}`);
  if (inspection.hints?.erc4626) log(`inspect: ERC-4626 vault of ${inspection.hints.erc4626.registrySymbol ?? inspection.hints.erc4626.asset}`);

  // 2. The same checks the API runs, locally, before anything is stored.
  const checked = validateContractDefinition(definition);
  if (!checked.ok) {
    for (const issue of checked.issues) log(`  ${issue.path}: ${issue.message}`);
    throw new Error("The definition is invalid; nothing was registered.");
  }
  log("validate: ok");

  // 3. Register (idempotent: a retry after a lost response returns the same registration).
  const { contract } = await kletia.contracts.register(definition);
  log(`register: ${contract.id} ${contract.status}${contract.activatesAt ? ` (activates ${contract.activatesAt})` : ""}`);

  // 4. A dry run of the first entry for your own account: plan, prepare, simulate, review.
  const entry = definition.actions[0];
  const test = await kletia.contracts.test(contract.id, {
    entry: entry.id,
    account: formatAccountId(definition.network, address),
    ...(entry.input ? { amount: "1" } : {}),
  });
  log(`test: simulation ${test.review.simulation?.status ?? "unknown"}; ${test.transactions.length} transaction(s) to sign`);
  for (const notice of test.review.notices) log(`  notice: ${notice}`);
  for (const warning of test.warnings) log(`  warning: ${warning}`);
  return { contract, test };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const file = args.find((arg) => arg.endsWith(".json")) ?? "contract.arbitrum-sepolia.json";
  const address = args[args.indexOf("--account") + 1];
  if (!process.env.KLETIA_API_KEY || !address || args.indexOf("--account") === -1) {
    console.error("Usage: KLETIA_API_KEY=kl_dev_… node register.mjs [contract.json] --account 0xYourWallet");
    process.exit(64);
  }
  const kletia = new KletiaClient({ apiKey: process.env.KLETIA_API_KEY, ...(process.env.KLETIA_BASE_URL ? { baseUrl: process.env.KLETIA_BASE_URL } : {}) });
  const definition = JSON.parse(await readFile(file, "utf8"));
  try {
    const { contract } = await registerAndTest(kletia, definition, address);
    console.log(`\nNext: CONTRACT_ID=${contract.id} KLETIA_API_KEY=… node session-server.mjs`);
  } catch (error) {
    console.error(`${error.code ? `${error.code}: ` : ""}${error.message}`);
    process.exit(1);
  }
}
