/**
 * The user's Polymarket wallet: CREATE2 derivation against real EOA ↔
 * wallet pairs read on Polygon (and the exchange's and Safe factory's own
 * derivations), discovery and its fail-closed checks, Safe orders
 * (signatureType 2) and Deposit Wallet orders (3, ERC-7739) against
 * @polymarket/clob-client-v2's own builder, SafeTx hashes against the Safes'
 * own getTransactionHash, Safe execTransaction steps, the relay guard, wallet
 * moves, redemption, positions, data extras and history labels. Recorded
 * fixtures only (fixtures/predictions/polymarket-wallets.json).
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { POLYMARKET_POLYGON, type DataTransaction, type PolymarketOrderDraft, type PredictionPrepared } from "@kletia/core";
import { decodeFunctionData, erc20Abi, getAddress, hashTypedData, parseAbi, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { PlatformError } from "../../errors.js";
import { readExtras } from "../../data/extras.js";
import { labelPolymarketWallets } from "../../data/transactions.js";
import { configurePredictionsIo } from "../../predictions/io.js";
import {
  DEFAULT_PREDICTIONS_POLICY,
  listPolymarketWallets,
  listPredictionOrders,
  preparePrediction,
  prepareRedeem,
  prepareWalletAction,
  readPredictionPositions,
  submitPrediction,
} from "../../predictions/service.js";
import { depositOrderTypedData, orderHash, wrapDepositSignature } from "../../predictions/signing.js";
import {
  polymarketWalletCandidates,
  polymarketWalletsOf,
  prevalidatedSignature,
  resetWalletCache,
  safeTransactionHash,
  walletKindOf,
} from "../../predictions/wallets.js";
import { loadPrediction, MARKET_666861, POSITIONS_SAFE, predictionFixtureIo, YES_TOKEN, type ChainState, type PredictionFixtureOptions } from "./predictionsHarness.js";

const P = POLYMARKET_POLYGON;
const RECORD = loadPrediction("polymarket-wallets.json") as {
  pairs: {
    kind: "safe" | "deposit" | "proxy"; eoa: string; wallet: string; code: Hex;
    onchain: { exchangeGetSafeWalletAddress: string; exchangeGetProxyWalletAddress: string; safeFactoryComputeProxyAddress: string };
    safe?: { owners: string[]; threshold: string; nonce: string; getTransactionHash: { to: string; data: Hex; nonce: string; hash: Hex } };
    owner?: string; profileProxyWallet: string | null;
  }[];
  orders: {
    base: { salt: string; tokenId: string; makerAmount: string; takerAmount: string; side: 0; timestamp: string };
    safe: { maker: string; signer: string; hashes: { ctfExchange: Hex; negRiskCtfExchange: Hex; exchangeV3: Hex } };
    deposit: { wallet: string; throwawaySigner: string; ctfExchange: Vector; exchangeV3: Vector };
  };
};
interface Vector { orderHash: Hex; innerSignature: Hex; signature: Hex; signedDigest: Hex }

const SAFE_CODE = RECORD.pairs.find((pair) => pair.kind === "safe")!.code;
const DEPOSIT_CODE = RECORD.pairs.find((pair) => pair.kind === "deposit")!.code;
const PROXY_CODE = RECORD.pairs.find((pair) => pair.kind === "proxy")!.code;

/** A throwaway owner (local key) with its derived Polymarket wallets, answered by the fixture chain. */
const owner = privateKeyToAccount(generatePrivateKey());
const ACCOUNT = `eip155:137:${owner.address}`;
const mine = polymarketWalletCandidates(owner.address);
const SAFE = mine.safe;
const DEPOSIT = mine.depositBeacon;
const low = (address: string) => address.toLowerCase();

function safeChain(extra: ChainState = {}): ChainState {
  return { pusd: 100_000_000n, codes: { [low(SAFE)]: SAFE_CODE }, safes: { [low(SAFE)]: { owners: [owner.address], nonce: 7n } }, ...extra };
}
function depositChain(extra: ChainState = {}): ChainState {
  return { pusd: 100_000_000n, codes: { [low(DEPOSIT)]: DEPOSIT_CODE }, depositOwners: { [low(DEPOSIT)]: owner.address }, ...extra };
}
const io = (chain: ChainState, more: PredictionFixtureOptions = {}) => predictionFixtureIo({ chain, ...more });
const BUY = { marketId: "666861", outcome: "Yes", side: "buy", amountUsd: "20", account: ACCOUNT };
const EXACT = { [`${low(P.pusd)}:${low(P.ctfExchange)}`]: 10n ** 12n };

async function refusal(promise: Promise<unknown>, code: string): Promise<PlatformError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof PlatformError, String(error));
    assert.equal(error.code, code, error.message);
    return error;
  }
  assert.fail(`expected ${code}`);
}

const execAbi = parseAbi(["function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)"]);

/** The inner call of a Safe step (execTransaction sent by the owner to the Safe). */
function innerCall(prepared: { readonly steps: PredictionPrepared["steps"] }, index: number): { to: string; data: Hex; signatures: Hex } {
  const step = prepared.steps[index]!;
  assert.ok(step.kind === "transaction" && step.transaction.vm === "evm");
  assert.equal(step.transaction.from, owner.address, "the owner sends it and pays the gas");
  assert.equal(step.transaction.to, SAFE);
  const call = decodeFunctionData({ abi: execAbi, data: step.transaction.data as Hex });
  const [to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, signatures] = call.args;
  assert.deepEqual([value, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver], [0n, 0, 0n, 0n, 0n, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000"], "a plain call: no delegatecall, no refund");
  return { to, data, signatures };
}

async function signTyped(typed: PredictionPrepared["steps"][number]): Promise<Hex> {
  assert.ok(typed.kind === "typed-data");
  const domain = { ...typed.typedData.domain, ...(typed.typedData.domain.verifyingContract ? { verifyingContract: typed.typedData.domain.verifyingContract as Hex } : {}) };
  return owner.signTypedData({ ...typed.typedData, domain } as never);
}

afterEach(() => {
  configurePredictionsIo(null);
  resetWalletCache();
});

describe("Polymarket wallets: derivation from real EOA ↔ wallet pairs", () => {
  it("derives every recorded wallet from its owner, as the exchange and the Safe factory do on-chain", () => {
    for (const pair of RECORD.pairs) {
      const candidates = polymarketWalletCandidates(pair.eoa);
      assert.equal(walletKindOf(pair.eoa, pair.wallet), pair.kind, `${pair.kind} ${pair.wallet}`);
      assert.equal(candidates.safe, getAddress(pair.onchain.exchangeGetSafeWalletAddress), "CTF Exchange getSafeWalletAddress");
      assert.equal(candidates.safe, getAddress(pair.onchain.safeFactoryComputeProxyAddress), "Safe factory computeProxyAddress");
      assert.equal(candidates.proxy, getAddress(pair.onchain.exchangeGetProxyWalletAddress), "CTF Exchange getProxyWalletAddress");
      assert.equal(getAddress(pair.profileProxyWallet ?? ""), getAddress(pair.wallet), "Polymarket's profile names the same wallet");
    }
    const [beacon, uups] = RECORD.pairs.filter((pair) => pair.kind === "deposit");
    assert.equal(polymarketWalletCandidates(beacon!.eoa).depositBeacon, getAddress(beacon!.wallet), "beacon Deposit Wallet (since June 29, 2026)");
    assert.equal(polymarketWalletCandidates(uups!.eoa).depositUups, getAddress(uups!.wallet), "UUPS Deposit Wallet (before)");
    assert.equal(walletKindOf(owner.address, RECORD.pairs[0]!.wallet), null, "another owner's wallet is none of this one's");
  });

  it("finds a Safe owned by the account, marks the profile's, and reads its balances", async () => {
    const view = await polymarketWalletsOf(owner.address, io(safeChain(), { profile: { status: 200, body: { proxyWallet: low(SAFE) } } }));
    assert.equal(view.wallets.length, 1);
    const [safe] = view.wallets;
    assert.deepEqual({ address: safe!.address, kind: safe!.kind, owner: safe!.owner, signatureType: safe!.signatureType, tradable: safe!.tradable, onProfile: safe!.onProfile }, { address: SAFE, kind: "safe", owner: owner.address, signatureType: 2, tradable: true, onProfile: true });
    assert.deepEqual(safe!.actions, ["deposit", "withdraw", "wrap"]);
    assert.deepEqual(safe!.balances, { pusd: "100", usdce: "0" });
    assert.match(safe!.verifiedBy, /getOwners\(\) on Polygon lists your wallet/u);
    assert.equal(view.profile.status, "listed");
  });

  it("finds a Deposit Wallet (tradable, moves on polymarket.com) and a Proxy wallet (read only)", async () => {
    const view = await polymarketWalletsOf(owner.address, io({ ...depositChain(), codes: { [low(DEPOSIT)]: DEPOSIT_CODE, [low(mine.proxy)]: PROXY_CODE } }));
    assert.deepEqual(view.wallets.map((wallet) => [wallet.kind, wallet.tradable, wallet.signatureType]), [["deposit", true, 3], ["proxy", false, 1]]);
    assert.deepEqual(view.wallets[0]!.actions, ["deposit"]);
    assert.match(view.wallets[0]!.note ?? "", /relayer/u);
    assert.match(view.wallets[1]!.note ?? "", /email or Google/u);
    assert.equal(view.profile.status, "none");
  });

  it("never guesses: a contract another owner controls, a profile wallet it cannot verify, an unreadable chain", async () => {
    const stranger = privateKeyToAccount(generatePrivateKey()).address;
    const taken = await polymarketWalletsOf(owner.address, io(safeChain({ safes: { [low(SAFE)]: { owners: [stranger] } } }), { profile: { status: 200, body: { proxyWallet: "0x1dab69f26c401d587d9e4875e68dd0d878818719" } } }));
    assert.equal(taken.wallets.length, 0);
    assert.match(taken.notes.join(" "), /no longer lists your wallet/u);
    assert.equal(taken.profile.status, "unverified");
    assert.match(taken.notes.join(" "), /could not verify/u);
    const fake = await polymarketWalletsOf(owner.address, io({ codes: { [low(mine.proxy)]: SAFE_CODE } }));
    assert.equal(fake.wallets.length, 0, "code at the proxy address that is not the factory's clone");
    await refusal(polymarketWalletsOf(owner.address, io({ unreadable: true })), "RPC_UNAVAILABLE");
    const none = await listPolymarketWallets(ACCOUNT, io({}));
    assert.deepEqual([none.wallets.length, none.plainWallet], [0, true]);
  });
});

describe("Polymarket wallets: orders and Safe transactions match Polymarket's and Safe's own", () => {
  const base = RECORD.orders.base;
  const draft = (patch: Partial<PolymarketOrderDraft>): PolymarketOrderDraft => ({
    ...base, maker: "", signer: "", signatureType: 0, metadata: `0x${"0".repeat(64)}`, builder: `0x${"0".repeat(64)}`, expiration: "0", orderType: "GTC", exchange: P.ctfExchange, domainVersion: "2", ...patch,
  });

  it("hashes a Safe order (maker = Safe, signer = owner, signatureType 2) as clob-client-v2 does", () => {
    const safe = draft({ maker: getAddress(RECORD.orders.safe.maker), signer: getAddress(RECORD.orders.safe.signer), signatureType: 2 });
    assert.equal(orderHash(safe), RECORD.orders.safe.hashes.ctfExchange);
    assert.equal(orderHash({ ...safe, exchange: P.negRiskCtfExchange }), RECORD.orders.safe.hashes.negRiskCtfExchange);
    assert.equal(orderHash({ ...safe, exchange: P.exchangeV3, domainVersion: "3" }), RECORD.orders.safe.hashes.exchangeV3);
  });

  it("builds a Deposit Wallet order's TypedDataSign and packs its signature exactly as clob-client-v2's buildOrderSignature", () => {
    const wallet = getAddress(RECORD.orders.deposit.wallet);
    for (const [exchange, domainVersion, vector] of [[P.ctfExchange, "2", RECORD.orders.deposit.ctfExchange], [P.exchangeV3, "3", RECORD.orders.deposit.exchangeV3]] as const) {
      const order = draft({ maker: wallet, signer: wallet, signatureType: 3, exchange, domainVersion });
      assert.equal(orderHash(order), vector.orderHash);
      const typed = depositOrderTypedData(order);
      assert.equal(hashTypedData({ ...typed, domain: { ...typed.domain, verifyingContract: typed.domain.verifyingContract as Hex } } as never), vector.signedDigest, "the digest the owner signs");
      assert.equal(wrapDepositSignature(order, vector.innerSignature), vector.signature);
    }
  });

  it("hashes SafeTx as both recorded Safes' getTransactionHash does", () => {
    for (const pair of RECORD.pairs.filter((entry) => entry.safe)) {
      const recorded = pair.safe!.getTransactionHash;
      assert.equal(safeTransactionHash(pair.wallet, { to: recorded.to, data: recorded.data }, BigInt(recorded.nonce)), recorded.hash);
    }
  });

  it("pre-validates the owner's signature (Safe 1.3.0: r = owner, s = 0, v = 1)", () => {
    const signature = prevalidatedSignature(owner.address);
    assert.equal(signature.length, 2 + 65 * 2);
    assert.equal(signature.slice(2, 66), owner.address.slice(2).toLowerCase().padStart(64, "0"));
    assert.equal(signature.slice(66, 130), "0".repeat(64));
    assert.equal(signature.slice(130), "01");
  });
});

describe("Polymarket wallets: trading from the Safe", () => {
  it("prepares approvals as the Safe's execTransaction and the order with maker = Safe, signer = owner", async () => {
    const prepared = await preparePrediction({ ...BUY, wallet: SAFE }, DEFAULT_PREDICTIONS_POLICY, io(safeChain()));
    assert.deepEqual(prepared.steps.map((step) => step.id), ["approve-pusd-exchange", "sign-in", "order"]);
    assert.deepEqual(prepared.wallet, { address: SAFE, kind: "safe", owner: owner.address });
    const inner = innerCall(prepared, 0);
    assert.equal(inner.to, P.pusd);
    assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: inner.data }).args, [P.ctfExchange, 20_000_000n], "exact amount, from the Safe");
    assert.equal(inner.signatures, prevalidatedSignature(owner.address));
    const approve = prepared.steps[0]!;
    assert.ok(approve.kind === "transaction" && approve.safeTx);
    assert.deepEqual(approve.safeTx, { safe: SAFE, nonce: "7", hash: safeTransactionHash(SAFE, inner, 7n) });
    assert.match(approve.transaction.description ?? "", /^Your Polymarket wallet 0x/u);
    assert.deepEqual([prepared.order.maker, prepared.order.signer, prepared.order.signatureType], [SAFE, owner.address, 2]);
    assert.match(prepared.steps[2]!.title, /from Your Polymarket wallet .*, owned by /u);
    const signIn = prepared.steps[1]!;
    assert.ok(signIn.kind === "typed-data" && signIn.typedData.message.address === owner.address, "the owner signs in to the CLOB");
  });

  it("relays the owner-signed Safe order with signatureType 2 after reading the Safe's owners again", async () => {
    const chain = safeChain({ allowances: EXACT });
    const fixture = io(chain);
    const prepared = await preparePrediction({ ...BUY, wallet: SAFE }, DEFAULT_PREDICTIONS_POLICY, fixture);
    const [signIn, order] = [prepared.steps.find((step) => step.id === "sign-in")!, prepared.steps.find((step) => step.id === "order")!];
    assert.ok(signIn.kind === "typed-data");
    const auth = { timestamp: Number(signIn.typedData.message.timestamp), signature: await signTyped(signIn) };
    const signature = await signTyped(order);
    const body = { account: ACCOUNT, order: prepared.order, ticket: prepared.ticket, signature, auth };
    const result = await submitPrediction(body, DEFAULT_PREDICTIONS_POLICY, fixture);
    assert.equal(result.status, "accepted");
    const post = fixture.requests.find((request) => request.url.endsWith("/order") && request.init.method === "POST");
    const sent = JSON.parse(post!.init.body!) as { order: Record<string, unknown> };
    assert.deepEqual([sent.order.maker, sent.order.signer, sent.order.signatureType, sent.order.signature], [SAFE, owner.address, 2, signature]);
    assert.ok(fixture.requests.some((request) => request.url.includes("/balance-allowance/update") && request.url.includes("signature_type=2")));
    // The Safe changed hands after prepare: the relay reads it again and refuses.
    const stranger = privateKeyToAccount(generatePrivateKey()).address;
    await refusal(submitPrediction(body, DEFAULT_PREDICTIONS_POLICY, io({ ...chain, safes: { [low(SAFE)]: { owners: [stranger] } } })), "PREDICTION_WALLET_NOT_FOUND");
    await refusal(submitPrediction(body, DEFAULT_PREDICTIONS_POLICY, io({ ...chain, unreadable: true })), "RPC_UNAVAILABLE");
  });

  it("refuses a wallet that is not the account's, an undeployed one, a Proxy wallet and a shared Safe", async () => {
    await refusal(preparePrediction({ ...BUY, wallet: RECORD.pairs[0]!.wallet }, DEFAULT_PREDICTIONS_POLICY, io(safeChain())), "PREDICTION_WALLET_NOT_FOUND");
    await refusal(preparePrediction({ ...BUY, wallet: SAFE }, DEFAULT_PREDICTIONS_POLICY, io({ pusd: 10n ** 9n })), "PREDICTION_WALLET_SETUP_REQUIRED");
    await refusal(preparePrediction({ ...BUY, wallet: mine.proxy }, DEFAULT_PREDICTIONS_POLICY, io({ codes: { [low(mine.proxy)]: PROXY_CODE } })), "PREDICTION_ACCOUNT_UNSUPPORTED");
    await refusal(preparePrediction({ ...BUY, wallet: SAFE }, DEFAULT_PREDICTIONS_POLICY, io(safeChain({ safes: { [low(SAFE)]: { owners: [owner.address, SAFE], threshold: 2n } } }))), "PREDICTION_ACCOUNT_UNSUPPORTED");
    await refusal(preparePrediction({ ...BUY, wallet: SAFE }, DEFAULT_PREDICTIONS_POLICY, io(safeChain({ pusd: 1_000_000n }))), "PREDICTION_BALANCE_TOO_LOW");
  });

  it("lists only the Safe's open orders when asked for the wallet", async () => {
    const fixture = io(safeChain());
    const signIn = (await preparePrediction({ ...BUY, wallet: SAFE }, DEFAULT_PREDICTIONS_POLICY, io(safeChain({ allowances: EXACT })))).steps.find((step) => step.id === "sign-in")!;
    assert.ok(signIn.kind === "typed-data");
    const { session } = await submitSession(fixture, Number(signIn.typedData.message.timestamp), await signTyped(signIn));
    const all = await listPredictionOrders({ account: ACCOUNT, session }, DEFAULT_PREDICTIONS_POLICY, fixture);
    assert.equal(all.orders.length, 1);
    assert.equal(all.orders[0]!.maker, null, "the recorded row names no maker");
    const safeOnly = await listPredictionOrders({ account: ACCOUNT, session, wallet: SAFE }, DEFAULT_PREDICTIONS_POLICY, fixture);
    assert.equal(safeOnly.orders.length, 0);
  });
});

async function submitSession(fixture: ReturnType<typeof io>, timestamp: number, signature: Hex): Promise<{ session: string }> {
  const { predictionSession } = await import("../../predictions/service.js");
  const made = await predictionSession({ account: ACCOUNT, auth: { timestamp, signature } }, DEFAULT_PREDICTIONS_POLICY, fixture);
  assert.ok(made.session);
  return { session: made.session };
}

describe("Polymarket wallets: trading from the Deposit Wallet", () => {
  it("prepares the TypedDataSign order when the wallet's approvals are set, and sends Polymarket's packed signature", async () => {
    const chain = depositChain({ allowances: EXACT });
    const fixture = io(chain);
    const prepared = await preparePrediction({ ...BUY, wallet: DEPOSIT }, DEFAULT_PREDICTIONS_POLICY, fixture);
    assert.deepEqual(prepared.steps.map((step) => step.id), ["sign-in", "order"]);
    assert.deepEqual([prepared.order.maker, prepared.order.signer, prepared.order.signatureType], [DEPOSIT, DEPOSIT, 3]);
    const order = prepared.steps[1]!;
    assert.ok(order.kind === "typed-data" && order.typedData.primaryType === "TypedDataSign");
    const signIn = prepared.steps[0]!;
    assert.ok(signIn.kind === "typed-data");
    const signature = await signTyped(order);
    const result = await submitPrediction({ account: ACCOUNT, order: prepared.order, ticket: prepared.ticket, signature, auth: { timestamp: Number(signIn.typedData.message.timestamp), signature: await signTyped(signIn) } }, DEFAULT_PREDICTIONS_POLICY, fixture);
    assert.equal(result.status, "accepted");
    const sent = JSON.parse(fixture.requests.find((request) => request.url.endsWith("/order") && request.init.method === "POST")!.init.body!) as { order: Record<string, unknown> };
    assert.equal(sent.order.signatureType, 3);
    assert.equal(sent.order.signature, wrapDepositSignature(prepared.order, signature), "the ERC-7739 packing, not the bare signature");
  });

  it("refuses what only Polymarket's relayer can do, and a signature the wallet rejects (ERC-1271)", async () => {
    const setup = await refusal(preparePrediction({ ...BUY, wallet: DEPOSIT }, DEFAULT_PREDICTIONS_POLICY, io(depositChain())), "PREDICTION_WALLET_SETUP_REQUIRED");
    assert.match(setup.message, /polymarket\.com/u);
    const chain = depositChain({ allowances: EXACT });
    const prepared = await preparePrediction({ ...BUY, wallet: DEPOSIT, hasSession: true }, DEFAULT_PREDICTIONS_POLICY, io(chain));
    const signature = await signTyped(prepared.steps.find((step) => step.id === "order")!);
    const body = { account: ACCOUNT, order: prepared.order, ticket: prepared.ticket, signature, session: "v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAA" };
    await refusal(submitPrediction(body, DEFAULT_PREDICTIONS_POLICY, io({ ...chain, accepts1271: false })), "PREDICTION_SIGNATURE_INVALID");
    const stranger = privateKeyToAccount(generatePrivateKey());
    const typed = prepared.steps.find((step) => step.id === "order")!;
    assert.ok(typed.kind === "typed-data");
    await refusal(submitPrediction({ ...body, signature: await stranger.signTypedData({ ...typed.typedData, domain: { ...typed.typedData.domain, verifyingContract: typed.typedData.domain.verifyingContract as Hex } } as never) }, DEFAULT_PREDICTIONS_POLICY, io(chain)), "PREDICTION_SIGNATURE_INVALID");
    await refusal(prepareWalletAction({ account: ACCOUNT, wallet: DEPOSIT, action: "withdraw", amountUsd: "5" }, DEFAULT_PREDICTIONS_POLICY, io(chain)), "PREDICTION_WALLET_SETUP_REQUIRED");
  });
});

describe("Polymarket wallets: moves, redemption, positions, data and history", () => {
  it("deposits by plain transfer, withdraws only to the owner, wraps inside the Safe", async () => {
    const deposit = await prepareWalletAction({ account: ACCOUNT, wallet: SAFE, action: "deposit", amountUsd: "25" }, DEFAULT_PREDICTIONS_POLICY, io(safeChain()));
    const transfer = deposit.steps[0]!;
    assert.ok(transfer.kind === "transaction" && transfer.transaction.vm === "evm");
    assert.deepEqual([transfer.transaction.from, transfer.transaction.to], [owner.address, P.pusd]);
    assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: transfer.transaction.data as Hex }).args, [SAFE, 25_000_000n]);
    const withdraw = await prepareWalletAction({ account: ACCOUNT, wallet: SAFE, action: "withdraw", amountUsd: "10", asset: "pUSD" }, DEFAULT_PREDICTIONS_POLICY, io(safeChain()));
    assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: innerCall(withdraw, 0).data }).args, [owner.address, 10_000_000n], "to the owner, nowhere else");
    const wrap = await prepareWalletAction({ account: ACCOUNT, wallet: SAFE, action: "wrap", amountUsd: "3" }, DEFAULT_PREDICTIONS_POLICY, io(safeChain({ usdce: 3_000_000n })));
    assert.deepEqual(wrap.steps.map((step) => step.id), ["approve-usdce", "wrap"]);
    assert.deepEqual(wrap.steps.map((step) => step.kind === "transaction" && step.safeTx?.nonce), ["7", "8"], "consecutive Safe nonces");
    const wrapped = decodeFunctionData({ abi: parseAbi(["function wrap(address _asset, address _to, uint256 _amount)"]), data: innerCall(wrap, 1).data });
    assert.deepEqual(wrapped.args, [P.usdce, SAFE, 3_000_000n]);
    await refusal(prepareWalletAction({ account: ACCOUNT, wallet: SAFE, action: "withdraw", amountUsd: "1000" }, DEFAULT_PREDICTIONS_POLICY, io(safeChain())), "PREDICTION_BALANCE_TOO_LOW");
    await refusal(prepareWalletAction({ account: ACCOUNT, wallet: SAFE, action: "steal", amountUsd: "1" }, DEFAULT_PREDICTIONS_POLICY, io(safeChain())), "INVALID_REQUEST");
  });

  it("redeems the Safe's resolved shares through the Safe", async () => {
    const redeem = await prepareRedeem({ account: ACCOUNT, conditionId: String(MARKET_666861.conditionId), wallet: SAFE }, DEFAULT_PREDICTIONS_POLICY, io(safeChain({ payoutDenominator: 1n, shares: { [YES_TOKEN]: 2_000_000n } })));
    assert.deepEqual(redeem.steps.map((step) => step.id), ["operator-0", "redeem"]);
    assert.equal(innerCall(redeem, 1).to, P.ctfCollateralAdapter);
    assert.equal(redeem.wallet?.kind, "safe");
  });

  it("reads the Safe's positions as the account's, verified", async () => {
    const fixture = io(safeChain(), { positions: { [low(SAFE)]: POSITIONS_SAFE } });
    const view = await readPredictionPositions({ account: ACCOUNT, wallet: SAFE }, fixture);
    assert.equal(view.holder, SAFE);
    assert.equal(view.tradable, true);
    assert.ok(view.positions.length > 0 && view.positions.every((position) => position.holder === SAFE));
    await refusal(readPredictionPositions({ account: ACCOUNT, wallet: RECORD.pairs[0]!.wallet }, fixture), "PREDICTION_WALLET_NOT_FOUND");
  });

  it("adds the Polymarket wallet's positions to data extras with who holds them", async () => {
    configurePredictionsIo(io(safeChain(), { positions: { [low(SAFE)]: POSITIONS_SAFE, [low(owner.address)]: { data: [] } } }));
    const extras = await readExtras({ evm: [owner.address], solana: [], lane: "production" } as never, { automationOwner: null, keyAuth: null });
    assert.deepEqual(extras.predictionWallets.map((wallet) => [wallet.address, wallet.kind, wallet.account]), [[SAFE, "safe", ACCOUNT]]);
    assert.ok(extras.predictions.rows.length > 0 && extras.predictions.rows.every((row) => row.holderKind === "safe" && row.account === ACCOUNT));
    assert.equal(extras.predictions.reason, null);
  });

  it("labels deposits into the own Polymarket wallet and calls through it in the history", async () => {
    configurePredictionsIo(io(safeChain()));
    const row = (counterparty: string, kind: DataTransaction["kind"]) => ({ id: `polygon:0x${kind}`, network: "polygon", counterparty, kind, protocol: null } as unknown as DataTransaction);
    const other = privateKeyToAccount(generatePrivateKey()).address;
    const labelled = await labelPolymarketWallets([row(SAFE, "send"), row(SAFE, "contract-call"), row(other, "send")], { evm: [owner.address] });
    assert.deepEqual(labelled.map((tx) => [tx.kind, tx.protocol?.label ?? null]), [["send", "Your Polymarket wallet"], ["prediction", "Your Polymarket wallet"], ["send", null]]);
    const untouched = await labelPolymarketWallets([row(other, "send")], { evm: [owner.address] });
    assert.equal(untouched[0]!.protocol, null);
  });
});
