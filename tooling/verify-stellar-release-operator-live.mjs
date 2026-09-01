import { readFile } from "node:fs/promises";

const manifestPath = new URL(
  "../contracts/stellar/deployments/testnet/release-operator.v1.json",
  import.meta.url,
);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const horizon = "https://horizon-testnet.stellar.org";

async function readJson(path) {
  const response = await fetch(`${horizon}${path}`, {
    headers: { Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) {
    throw new Error(`Stellar Testnet returned HTTP ${response.status}.`);
  }
  return response.json();
}

if (
  manifest.schemaVersion !== "kletia_stellar_release_operator_v1" ||
  manifest.network !== "stellar_testnet" ||
  !/^G[A-Z2-7]{55}$/u.test(manifest.publicKey || "") ||
  !/^[a-f0-9]{64}$/u.test(
    manifest.friendbotFundingEvidence?.transactionHash || "",
  )
) {
  throw new Error("The committed release-operator manifest is invalid.");
}

const [account, transaction] = await Promise.all([
  readJson(`/accounts/${manifest.publicKey}`),
  readJson(
    `/transactions/${manifest.friendbotFundingEvidence.transactionHash}`,
  ),
]);

const nativeBalance = account.balances?.find(
  (balance) => balance.asset_type === "native",
);
if (
  account.account_id !== manifest.publicKey ||
  !nativeBalance ||
  Number(nativeBalance.balance) <= 0 ||
  transaction.successful !== true ||
  transaction.ledger !== manifest.friendbotFundingEvidence.ledger ||
  transaction.operation_count !== 1
) {
  throw new Error(
    "The live Testnet account or Friendbot transaction no longer matches the release manifest.",
  );
}

console.log(
  JSON.stringify({
    status: "ready",
    network: manifest.network,
    publicKey: manifest.publicKey,
    latestAccountLedger: account.last_modified_ledger,
    balanceXlm: nativeBalance.balance,
    fundingTransaction: transaction.hash,
    fundingLedger: transaction.ledger,
    secretObserved: false,
  }),
);
