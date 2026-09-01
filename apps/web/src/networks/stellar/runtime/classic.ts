import {
  Asset,
  FeeBumpTransaction,
  Horizon,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  type Transaction,
} from "@stellar/stellar-sdk";

const HORIZON_URL = "https://horizon-testnet.stellar.org";
export const STELLAR_TESTNET_USDC_ISSUER =
  "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

type AssetDescriptor =
  | { kind: "native"; symbol: "XLM" }
  | {
      kind: "stellar_classic";
      symbol: "USDC";
      code: "USDC";
      issuer: string;
    };

export interface StellarPathQuote {
  mode: "strict_send" | "strict_receive";
  sourceAsset: AssetDescriptor;
  destinationAsset: AssetDescriptor;
  selectedRoute: {
    sourceAmount: string;
    destinationAmount: string;
    path: Array<{
      asset_type?: string;
      asset_code?: string;
      asset_issuer?: string;
    }>;
    intermediateAssetIdentities: string[];
  };
  executionPolicy: {
    venue: "stellar_classic_path_payment";
    slippageBps: 50;
    intermediateAssets: "reviewed_direct_pair_only";
    warning: string;
  };
  aquarius?: {
    comparisonStatus?: string;
    quotedAmountAtomic?: string;
    executionEnabled?: boolean;
    reason?: string;
  };
  quoteExpiresAt: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function isAmount(value: unknown): value is string {
  return typeof value === "string" && /^\d+(?:\.\d{1,7})?$/u.test(value);
}

export function validateStellarPathQuote(value: unknown): StellarPathQuote {
  if (!isRecord(value) || !isRecord(value.sourceAsset) || !isRecord(value.destinationAsset)) {
    throw new Error("The Stellar route response is invalid.");
  }
  const source = value.sourceAsset;
  const destination = value.destinationAsset;
  const isReviewedXlm = (candidate: Record<string, unknown>) =>
    candidate.kind === "native" && candidate.symbol === "XLM";
  const isReviewedUsdc = (candidate: Record<string, unknown>) =>
    candidate.kind === "stellar_classic" &&
    candidate.symbol === "USDC" &&
    candidate.code === "USDC" &&
    candidate.issuer === STELLAR_TESTNET_USDC_ISSUER;
  if (
    !((isReviewedXlm(source) && isReviewedUsdc(destination)) ||
      (isReviewedUsdc(source) && isReviewedXlm(destination))) ||
    (value.mode !== "strict_send" && value.mode !== "strict_receive") ||
    !isRecord(value.selectedRoute) ||
    !isAmount(value.selectedRoute.sourceAmount) ||
    !isAmount(value.selectedRoute.destinationAmount) ||
    !Array.isArray(value.selectedRoute.path) ||
    value.selectedRoute.path.length !== 0 ||
    !Array.isArray(value.selectedRoute.intermediateAssetIdentities) ||
    value.selectedRoute.intermediateAssetIdentities.length !== 0 ||
    !isRecord(value.executionPolicy) ||
    value.executionPolicy.venue !== "stellar_classic_path_payment" ||
    value.executionPolicy.slippageBps !== 50 ||
    value.executionPolicy.intermediateAssets !== "reviewed_direct_pair_only" ||
    typeof value.executionPolicy.warning !== "string" ||
    typeof value.quoteExpiresAt !== "number" ||
    value.quoteExpiresAt <= Date.now() ||
    value.quoteExpiresAt > Date.now() + 5 * 60_000
  ) {
    throw new Error("The Stellar route response failed its reviewed execution boundary.");
  }
  const identities = value.selectedRoute.intermediateAssetIdentities;
  const pathValid = value.selectedRoute.path.every((entry, index) => {
    if (!isRecord(entry)) return false;
    if (entry.asset_type === "native") return identities[index] === "native";
    return (
      (entry.asset_type === "credit_alphanum4" || entry.asset_type === "credit_alphanum12") &&
      typeof entry.asset_code === "string" &&
      typeof entry.asset_issuer === "string" &&
      StrKey.isValidEd25519PublicKey(entry.asset_issuer) &&
      identities[index] === `${entry.asset_code}:${entry.asset_issuer}`
    );
  });
  if (!pathValid || new Set(identities).size !== identities.length) {
    throw new Error("The Stellar route contains an invalid or cyclic intermediate asset path.");
  }
  return value as unknown as StellarPathQuote;
}

function asset(descriptor: AssetDescriptor): Asset {
  return descriptor.kind === "native"
    ? Asset.native()
    : new Asset(descriptor.code, descriptor.issuer);
}

function pathAsset(entry: StellarPathQuote["selectedRoute"]["path"][number]): Asset {
  if (entry.asset_type === "native") return Asset.native();
  if (
    typeof entry.asset_code === "string" &&
    typeof entry.asset_issuer === "string"
  ) {
    return new Asset(entry.asset_code, entry.asset_issuer);
  }
  throw new Error("The Horizon path contains an invalid asset.");
}

function withSlippage(
  amount: string,
  direction: "minimum" | "maximum",
  slippageBps: number,
): string {
  const [whole = "0", fraction = ""] = amount.split(".");
  const atomic = BigInt(`${whole}${fraction.padEnd(7, "0").slice(0, 7)}`);
  if (atomic <= 0n) throw new Error("The Horizon quote amount is invalid.");
  const adjusted =
    direction === "minimum"
      ? (atomic * BigInt(10_000 - slippageBps)) / 10_000n
      : (atomic * BigInt(10_000 + slippageBps) + 9_999n) / 10_000n;
  return `${adjusted / 10_000_000n}.${(adjusted % 10_000_000n)
    .toString()
    .padStart(7, "0")}`;
}

const CLASSIC_FEE_CAP_STROOPS = 1_000_000n;

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function assertCommonClassicTransaction(input: {
  transaction: Transaction;
  sourceAccount: string;
}): void {
  const { transaction } = input;
  if (
    transaction.source !== input.sourceAccount ||
    transaction.operations.length !== 1 ||
    transaction.memo.type !== "none" ||
    BigInt(transaction.fee) <= 0n ||
    BigInt(transaction.fee) > CLASSIC_FEE_CAP_STROOPS ||
    !transaction.timeBounds ||
    Number(transaction.timeBounds.maxTime) <= Math.floor(Date.now() / 1_000) ||
    Number(transaction.timeBounds.maxTime) > Math.floor(Date.now() / 1_000) + 180
  ) {
    throw new Error(
      "The prepared Stellar transaction changed its source, operation count, memo, fee, or time bounds.",
    );
  }
}

function assertPreparedSdexTransaction(input: {
  unsignedXdr: string;
  sourceAccount: string;
  quote: StellarPathQuote;
}): void {
  const transaction = TransactionBuilder.fromXdr(
    input.unsignedXdr,
    Networks.TESTNET,
  );
  if (transaction instanceof FeeBumpTransaction) {
    throw new Error("Fee-bump transactions are not accepted by this Stellar route.");
  }
  assertCommonClassicTransaction({ transaction, sourceAccount: input.sourceAccount });
  const operation = transaction.operations[0];
  const expectedPath = input.quote.selectedRoute.path.map(pathAsset);
  const pathMatches = (candidate: readonly Asset[]) =>
    candidate.length === expectedPath.length &&
    candidate.every((entry, index) => entry.equals(expectedPath[index]!));
  if (input.quote.mode === "strict_send") {
    if (
      operation?.type !== "pathPaymentStrictSend" ||
      operation.destination !== input.sourceAccount ||
      !operation.sendAsset.equals(asset(input.quote.sourceAsset)) ||
      !operation.destAsset.equals(asset(input.quote.destinationAsset)) ||
      operation.sendAmount !== input.quote.selectedRoute.sourceAmount ||
      operation.destMin !==
        withSlippage(
          input.quote.selectedRoute.destinationAmount,
          "minimum",
          input.quote.executionPolicy.slippageBps,
        ) ||
      !pathMatches(operation.path)
    ) {
      throw new Error("The prepared strict-send XDR does not match the sealed live quote.");
    }
    return;
  }
  if (
    operation?.type !== "pathPaymentStrictReceive" ||
    operation.destination !== input.sourceAccount ||
    !operation.sendAsset.equals(asset(input.quote.sourceAsset)) ||
    !operation.destAsset.equals(asset(input.quote.destinationAsset)) ||
    operation.sendMax !==
      withSlippage(
        input.quote.selectedRoute.sourceAmount,
        "maximum",
        input.quote.executionPolicy.slippageBps,
      ) ||
    operation.destAmount !== input.quote.selectedRoute.destinationAmount ||
    !pathMatches(operation.path)
  ) {
    throw new Error("The prepared strict-receive XDR does not match the sealed live quote.");
  }
}

export async function prepareStellarSdexPathPayment(input: {
  sourceAccount: string;
  quote: StellarPathQuote;
}): Promise<string> {
  if (input.quote.quoteExpiresAt <= Date.now()) {
    throw new Error("The SDEX quote expired. Request a fresh comparison.");
  }
  const server = new Horizon.Server(HORIZON_URL);
  const [account, baseFee] = await Promise.all([
    server.loadAccount(input.sourceAccount),
    server.fetchBaseFee(),
  ]);
  const common = {
    destination: input.sourceAccount,
    sendAsset: asset(input.quote.sourceAsset),
    destAsset: asset(input.quote.destinationAsset),
    path: input.quote.selectedRoute.path.map(pathAsset),
  };
  const operation =
    input.quote.mode === "strict_send"
      ? Operation.pathPaymentStrictSend({
          ...common,
          sendAmount: input.quote.selectedRoute.sourceAmount,
          destMin: withSlippage(
            input.quote.selectedRoute.destinationAmount,
            "minimum",
            input.quote.executionPolicy.slippageBps,
          ),
        })
      : Operation.pathPaymentStrictReceive({
          ...common,
          sendMax: withSlippage(
            input.quote.selectedRoute.sourceAmount,
            "maximum",
            input.quote.executionPolicy.slippageBps,
          ),
          destAmount: input.quote.selectedRoute.destinationAmount,
        });
  const unsignedXdr = new TransactionBuilder(account, {
    fee: String(Math.max(baseFee, 100)),
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(operation)
    .setTimeout(120)
    .build()
    .toXdr();
  assertPreparedSdexTransaction({ ...input, unsignedXdr });
  return unsignedXdr;
}

export async function submitSignedStellarClassicTransaction(
  signedXdr: string,
  expectedUnsignedXdr: string,
): Promise<string> {
  const server = new Horizon.Server(HORIZON_URL);
  const transaction = TransactionBuilder.fromXdr(signedXdr, Networks.TESTNET);
  const expected = TransactionBuilder.fromXdr(
    expectedUnsignedXdr,
    Networks.TESTNET,
  );
  if (
    transaction instanceof FeeBumpTransaction ||
    expected instanceof FeeBumpTransaction ||
    !equalBytes(transaction.hash(), expected.hash())
  ) {
    throw new Error(
      "The Stellar wallet returned a transaction body that differs from the reviewed XDR.",
    );
  }
  const result = await server.submitTransaction(transaction);
  if (!result.successful || typeof result.hash !== "string") {
    throw new Error("The Stellar transaction did not reach a successful ledger result.");
  }
  return result.hash;
}

function normalizeStellarAmount(value: string): string {
  const trimmed = value.trim();
  if (!/^(?:\d+\.?\d*|\.\d+)$/u.test(trimmed)) {
    throw new Error("Enter a positive Stellar amount with at most seven decimals.");
  }
  const [whole = "0", fraction = ""] = trimmed.split(".");
  if (fraction.length > 7) {
    throw new Error("Stellar Classic amounts support at most seven decimals.");
  }
  const atomic = BigInt(`${whole || "0"}${fraction.padEnd(7, "0")}`);
  if (atomic <= 0n) throw new Error("The transfer amount must be positive.");
  return `${atomic / 10_000_000n}.${(atomic % 10_000_000n)
    .toString()
    .padStart(7, "0")}`;
}

function stellarDisplayAmountToAtomic(value: string, allowZero = false): bigint {
  if (!/^\d+(?:\.\d{1,7})?$/u.test(value)) {
    throw new Error("Stellar returned an invalid decimal amount.");
  }
  const [whole = "0", fraction = ""] = value.split(".");
  const atomic = BigInt(`${whole}${fraction.padEnd(7, "0")}`);
  if (allowZero ? atomic < 0n : atomic <= 0n) {
    throw new Error("Stellar returned a non-positive amount.");
  }
  return atomic;
}

export async function prepareStellarUsdcTrustline(input: {
  sourceAccount: string;
}): Promise<string> {
  if (!StrKey.isValidEd25519PublicKey(input.sourceAccount)) {
    throw new Error("The connected Stellar source account is invalid.");
  }
  const server = new Horizon.Server(HORIZON_URL);
  const [source, baseFee] = await Promise.all([
    server.loadAccount(input.sourceAccount),
    server.fetchBaseFee(),
  ]);
  const existing = source.balances.find(
    (balance) =>
      balance.asset_type !== "native" &&
      "asset_code" in balance &&
      "asset_issuer" in balance &&
      balance.asset_code === "USDC" &&
      balance.asset_issuer === STELLAR_TESTNET_USDC_ISSUER,
  );
  if (existing) {
    throw new Error("This account already has the reviewed Circle Testnet USDC trustline.");
  }
  const reviewedUsdc = new Asset("USDC", STELLAR_TESTNET_USDC_ISSUER);
  const unsignedXdr = new TransactionBuilder(source, {
    fee: String(Math.max(baseFee, 100)),
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.changeTrust({ asset: reviewedUsdc }))
    .setTimeout(120)
    .build()
    .toXdr();
  const transaction = TransactionBuilder.fromXdr(unsignedXdr, Networks.TESTNET);
  if (transaction instanceof FeeBumpTransaction) {
    throw new Error("Fee-bump transactions are not accepted by this trustline flow.");
  }
  assertCommonClassicTransaction({ transaction, sourceAccount: input.sourceAccount });
  const operation = transaction.operations[0];
  if (
    operation?.type !== "changeTrust" ||
    !(operation.line instanceof Asset) ||
    operation.line.code !== reviewedUsdc.code ||
    operation.line.issuer !== reviewedUsdc.issuer
  ) {
    throw new Error("The prepared trustline XDR does not match reviewed Circle Testnet USDC.");
  }
  return unsignedXdr;
}

export async function prepareStellarPayment(input: {
  sourceAccount: string;
  destination: string;
  symbol: "XLM" | "USDC";
  amount: string;
}): Promise<string> {
  if (!StrKey.isValidEd25519PublicKey(input.sourceAccount)) {
    throw new Error("The connected Stellar source account is invalid.");
  }
  if (!StrKey.isValidEd25519PublicKey(input.destination)) {
    throw new Error("Enter a valid Stellar destination G-address.");
  }
  const server = new Horizon.Server(HORIZON_URL);
  const normalizedAmount = normalizeStellarAmount(input.amount);
  const [source, destination, baseFee] = await Promise.all([
    server.loadAccount(input.sourceAccount),
    server.loadAccount(input.destination).catch(() => null),
    server.fetchBaseFee(),
  ]);
  if (!destination) {
    throw new Error("The destination account does not exist on Stellar Testnet.");
  }
  const paymentAsset =
    input.symbol === "XLM"
      ? Asset.native()
      : new Asset("USDC", STELLAR_TESTNET_USDC_ISSUER);
  if (input.symbol === "USDC") {
    const sourceTrustline = source.balances.find(
      (balance) =>
        balance.asset_type !== "native" &&
        "asset_code" in balance &&
        "asset_issuer" in balance &&
        balance.asset_code === "USDC" &&
        balance.asset_issuer === STELLAR_TESTNET_USDC_ISSUER,
    );
    const trustline = destination.balances.find(
      (balance) =>
        balance.asset_type !== "native" &&
        "asset_code" in balance &&
        "asset_issuer" in balance &&
        balance.asset_code === "USDC" &&
        balance.asset_issuer === STELLAR_TESTNET_USDC_ISSUER,
    );
    if (
      !sourceTrustline ||
      ("is_authorized" in sourceTrustline && sourceTrustline.is_authorized === false)
    ) {
      throw new Error("The source lacks an authorized Circle Testnet USDC trustline.");
    }
    if (
      stellarDisplayAmountToAtomic(sourceTrustline.balance, true) <
      stellarDisplayAmountToAtomic(normalizedAmount)
    ) {
      throw new Error("The Circle Testnet USDC balance is insufficient.");
    }
    if (!trustline || ("is_authorized" in trustline && trustline.is_authorized === false)) {
      throw new Error("The destination lacks an authorized Circle Testnet USDC trustline.");
    }
  }
  const unsignedXdr = new TransactionBuilder(source, {
    fee: String(Math.max(baseFee, 100)),
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: input.destination,
        asset: paymentAsset,
        amount: normalizedAmount,
      }),
    )
    .setTimeout(120)
    .build()
    .toXdr();
  const transaction = TransactionBuilder.fromXdr(unsignedXdr, Networks.TESTNET);
  if (transaction instanceof FeeBumpTransaction) {
    throw new Error("Fee-bump transactions are not accepted by this Stellar transfer.");
  }
  assertCommonClassicTransaction({ transaction, sourceAccount: input.sourceAccount });
  const operation = transaction.operations[0];
  if (
    operation?.type !== "payment" ||
    operation.destination !== input.destination ||
    !operation.asset.equals(paymentAsset) ||
    operation.amount !== normalizedAmount
  ) {
    throw new Error("The prepared payment XDR does not match the reviewed transfer.");
  }
  return unsignedXdr;
}
