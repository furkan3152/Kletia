/**
 * Operator anchoring of the receipt transparency log (receipts design §7.4).
 *
 *   npx tsx src/scripts/receipts/anchorLog.ts [--api https://api.kletiaai.xyz] [--rpc https://mainnet.base.org]
 *   npx tsx src/scripts/receipts/anchorLog.ts --send          # operator opt-in: signs and broadcasts
 *
 * Reads the unanchored batches (`GET /v1/receipts/log?unanchored=true`),
 * re-checks each batch document against its digest, skips batches EAS already
 * timestamped (`getTimestamp(batchDigest)`, read-only), and prints the
 * calldata of `EAS.timestamp(batchDigest)` for the EAS predeploy on Base.
 *
 * Dry run by default: nothing is signed or sent. With `--send` (and only
 * then) the script signs with KLETIA_ANCHOR_PRIVATE_KEY (the operator's gas
 * wallet, held by this process only; the API never loads it), simulates the
 * call first, broadcasts it on Base (chain 8453 checked), waits for the
 * receipt, and reports the transaction with POST
 * /v1/receipts/log/{seq}/anchor using KLETIA_OPERATOR_API_KEY. The API
 * accepts it only after reading the transaction itself. Anyone else can
 * anchor a published batch digest the same way; the result is the same
 * `getTimestamp` entry.
 */
import { createPublicClient, createWalletClient, http, isHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { RECEIPT_DIGEST_PATTERN, receiptLogBatchDigest, type ReceiptLogBatch } from "@kletia/core";

const EAS_ADDRESS = "0x4200000000000000000000000000000000000021";
const TIMESTAMP_SELECTOR = "0x4d003070";
const GET_TIMESTAMP_SELECTOR = "0xd45c4435";

interface BatchView {
  readonly seq: number;
  readonly batch: ReceiptLogBatch;
  readonly batchDigest: string;
  readonly anchor: unknown;
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

async function unanchoredBatches(api: string): Promise<BatchView[]> {
  const response = await fetch(`${api}/v1/receipts/log?unanchored=true&limit=100`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`GET /v1/receipts/log answered ${response.status}.`);
  const body = (await response.json()) as { batches?: unknown };
  if (!Array.isArray(body.batches)) throw new Error("The log listing has no batches array.");
  return body.batches as BatchView[];
}

async function main(): Promise<void> {
  const api = (option("api") ?? process.env.KLETIA_API_ORIGIN ?? "https://api.kletiaai.xyz").replace(/\/+$/u, "");
  const rpc = option("rpc") ?? process.env.BASE_RPC_URL?.trim() ?? "https://mainnet.base.org";
  const send = process.argv.includes("--send");
  const client = createPublicClient({ chain: base, transport: http(rpc) });
  const chainId = await client.getChainId();
  if (chainId !== 8453) throw new Error(`The RPC serves chain ${chainId}, not Base (8453).`);

  const batches = (await unanchoredBatches(api)).sort((a, b) => a.seq - b.seq);
  const plan: { seq: number; batchDigest: string; to: string; data: Hex; status: string }[] = [];
  for (const entry of batches) {
    // Never anchor a digest that does not match its document.
    if (!RECEIPT_DIGEST_PATTERN.test(entry.batchDigest) || receiptLogBatchDigest(entry.batch) !== entry.batchDigest) {
      plan.push({ seq: entry.seq, batchDigest: entry.batchDigest, to: EAS_ADDRESS, data: "0x", status: "skipped: digest does not match the batch document" });
      continue;
    }
    const existing = await client.call({ to: EAS_ADDRESS, data: `${GET_TIMESTAMP_SELECTOR}${entry.batchDigest}` as Hex });
    const timestamp = existing.data && isHex(existing.data) ? BigInt(existing.data) : 0n;
    const data = `${TIMESTAMP_SELECTOR}${entry.batchDigest}` as Hex;
    plan.push({ seq: entry.seq, batchDigest: entry.batchDigest, to: EAS_ADDRESS, data, status: timestamp > 0n ? `already timestamped at ${timestamp}` : "to anchor" });
  }

  if (!send) {
    console.log(JSON.stringify({ mode: "dry-run (nothing signed or sent)", api, rpc, chainId, batches: plan }, null, 2));
    return;
  }

  const key = process.env.KLETIA_ANCHOR_PRIVATE_KEY?.trim();
  const operatorKey = process.env.KLETIA_OPERATOR_API_KEY?.trim();
  if (!key || !/^0x[0-9a-fA-F]{64}$/u.test(key)) throw new Error("--send needs KLETIA_ANCHOR_PRIVATE_KEY (0x + 64 hex), the operator gas wallet.");
  if (!operatorKey) throw new Error("--send needs KLETIA_OPERATOR_API_KEY to report the anchoring transaction.");
  const account = privateKeyToAccount(key as Hex);
  const wallet = createWalletClient({ account, chain: base, transport: http(rpc) });
  for (const entry of plan.filter((item) => item.status === "to anchor")) {
    // Simulate first: a batch someone else anchored meanwhile reverts here, not on-chain.
    await client.call({ account: account.address, to: EAS_ADDRESS, data: entry.data });
    const hash = await wallet.sendTransaction({ to: EAS_ADDRESS, data: entry.data, value: 0n, chain: base });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      console.error(`batch ${entry.seq}: ${hash} reverted`);
      continue;
    }
    const reported = await fetch(`${api}/v1/receipts/log/${entry.seq}/anchor`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${operatorKey}` },
      body: JSON.stringify({ tx: hash }),
      signal: AbortSignal.timeout(30_000),
    });
    console.log(`batch ${entry.seq}: anchored by ${hash}; report answered ${reported.status}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
