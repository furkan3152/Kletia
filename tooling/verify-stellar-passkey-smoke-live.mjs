import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

const requireFromApi = createRequire(
  new URL("../apps/api/package.json", import.meta.url),
);
const { xdr } = requireFromApi("@stellar/stellar-sdk");
const manifestPath = new URL(
  "../contracts/stellar/deployments/testnet/passkey-smoke.v1.json",
  import.meta.url,
);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const rpcUrl = "https://soroban-testnet.stellar.org";
const horizonUrl = "https://horizon-testnet.stellar.org";

async function rpc(method, params) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json();
  if (!response.ok || body.error) {
    throw new Error(body.error?.message || `Stellar RPC returned HTTP ${response.status}.`);
  }
  return body.result;
}

async function horizon(path) {
  const response = await fetch(`${horizonUrl}${path}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Horizon returned HTTP ${response.status}.`);
  return response.json();
}

if (
  manifest.schemaVersion !== "kletia_stellar_passkey_smoke_v1" ||
  manifest.network !== "stellar_testnet" ||
  !/^C[A-Z2-7]{55}$/u.test(manifest.account?.contractId || "") ||
  manifest.authenticatorEvidence?.algorithm !== "secp256r1" ||
  manifest.authenticatorEvidence?.virtualAuthenticator !== true ||
  manifest.authenticatorEvidence?.physicalUserVerificationObserved !== false ||
  manifest.authenticatorEvidence?.credentialMaterialCommitted !== false ||
  manifest.claimBoundary?.realTestnetPasskeyAuthorizedTransfer !== true ||
  manifest.claimBoundary?.humanBiometricCeremony !== false ||
  manifest.claimBoundary?.publicHttpsDeployment !== false ||
  manifest.claimBoundary?.productionReady !== false
) {
  throw new Error("The committed passkey smoke boundary is invalid.");
}

const entries = Object.entries(manifest.transactions);
const results = await Promise.all(
  entries.map(async ([name, evidence]) => {
    if (!/^[a-f0-9]{64}$/u.test(evidence.hash || "")) {
      throw new Error(`The ${name} transaction hash is invalid.`);
    }
    const transaction = await rpc("getTransaction", { hash: evidence.hash });
    if (
      transaction.status !== "SUCCESS" ||
      transaction.ledger !== evidence.ledger ||
      transaction.txHash !== evidence.hash
    ) {
      throw new Error(`The ${name} transaction no longer matches live Testnet evidence.`);
    }
    return [name, transaction];
  }),
);
const transactions = Object.fromEntries(results);

const transferEvents = transactions.transfer.events?.contractEventsXdr
  ?.flat()
  .map((eventXdr) => xdr.ContractEvent.fromXDR(eventXdr, "base64").toJSON()) || [];
const expectedTransfer = manifest.transactions.transfer;
const matchingTransfer = transferEvents.find((event) => {
  const value = event.body?.v0;
  const topics = value?.topics || [];
  return (
    event.contract_id === expectedTransfer.assetContract &&
    topics[0]?.symbol === "transfer" &&
    topics[1]?.address === manifest.account.contractId &&
    topics[2]?.address === expectedTransfer.recipient &&
    value?.data?.i128 === expectedTransfer.amountAtomic
  );
});
if (!matchingTransfer) {
  throw new Error("The live transaction does not contain the exact XLM transfer event.");
}

const recipient = await horizon(`/accounts/${expectedTransfer.recipient}`);
const nativeBalance = recipient.balances?.find(
  (balance) => balance.asset_type === "native",
);
if (
  recipient.account_id !== expectedTransfer.recipient ||
  !nativeBalance ||
  Number(nativeBalance.balance) < Number(expectedTransfer.observedRecipientBalanceXlm) ||
  recipient.last_modified_ledger < expectedTransfer.ledger
) {
  throw new Error("The live recipient balance does not preserve the transfer evidence.");
}

console.log(
  JSON.stringify({
    status: "verified",
    network: manifest.network,
    contractId: manifest.account.contractId,
    createTransaction: manifest.transactions.create.hash,
    fundTransaction: manifest.transactions.fund.hash,
    transferTransaction: expectedTransfer.hash,
    transferLedger: expectedTransfer.ledger,
    transferAmountXlm: expectedTransfer.amount,
    recipient: expectedTransfer.recipient,
    currentRecipientBalanceXlm: nativeBalance.balance,
    virtualAuthenticator: true,
    physicalUserVerificationObserved: false,
    credentialMaterialObserved: false
  }),
);
