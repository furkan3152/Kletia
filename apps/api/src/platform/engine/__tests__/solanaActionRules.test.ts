/**
 * Solana Actions rules without a network: response handling (transaction
 * only), metadata, URL templates, the structure rules (signers, programs,
 * System / Token / ATA / ComputeBudget restrictions, durable nonce, size),
 * the CPI scan, the amount rules, re-blockhashing and the instruction digest.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { getCompiledTransactionMessageDecoder, getTransactionDecoder } from "@solana/kit";
import { WRAPPED_SOL_MINT } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { decodeSolanaTransaction, type SolanaInnerInstruction } from "../chains/solana.js";
import {
  actionInstructionDigest,
  actionMetadataUrl,
  checkActionTransaction,
  decodeActionTransaction,
  fetchActionTransaction,
  fetchSolanaActionMetadata,
  fillActionHref,
  innerInstructionRefusal,
  outcomeRefusal,
  withBlockhash,
  type ActionRules,
} from "../contracts/solanaActions.js";
import { installRpcRouter, type RpcRouter } from "./contractHarness.js";
import {
  ACME_HELPER,
  ACME_PROGRAM,
  buildTransaction,
  CannedTransport,
  ix,
  JUP6,
  NOOP,
  presign,
  randomAddress,
  SOL_OTHER,
  SOL_USER,
  SYSTEM,
  TOKEN,
  USDC_MINT,
} from "./solanaActionHarness.js";

const fixtures = JSON.parse(readFileSync(new URL("./contractFixtures.json", import.meta.url), "utf8")) as {
  jupiterBlink: { transaction: string };
  jupiterLookupTables: { tables: string[]; value: unknown[] };
  transferSol: { transaction: string; message: string };
};
const NICK = "nick6zJc6HpW3kfBm4xS2dmbuVRyb5F3AnUvj5ymzR5";

let router: RpcRouter;

beforeEach(() => {
  router = installRpcRouter();
  router.handlers.set("getMultipleAccounts", ([keys]) => ({
    context: { slot: 1 },
    value: (keys as string[]).map((key) => {
      const index = fixtures.jupiterLookupTables.tables.indexOf(key);
      return index >= 0 ? fixtures.jupiterLookupTables.value[index] : null;
    }),
  }));
});

afterEach(() => router.restore());

const rules = (overrides: Partial<ActionRules> = {}): ActionRules => ({
  user: SOL_USER,
  network: "solana",
  programs: [ACME_PROGRAM, ACME_HELPER],
  primaryProgram: ACME_PROGRAM,
  payees: [],
  ...overrides,
});

async function check(base64: string, overrides: Partial<ActionRules> = {}) {
  const decoded = await decodeActionTransaction("solana", base64, decodeSolanaTransaction);
  return checkActionTransaction(base64, decoded, rules(overrides));
}

function refusedWith(code: string, pattern: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof PlatformError, String(error));
    assert.equal(error.code, code, error.message);
    assert.match(error.message, pattern);
    return true;
  };
}

describe("Solana Actions: live fixtures", () => {
  it("accepts the Jupiter blink (v0, lookup table) with JUP6 and noop allowlisted", async () => {
    const structure = await check(fixtures.jupiterBlink.transaction, { programs: [JUP6, NOOP], primaryProgram: JUP6 });
    assert.equal(structure.payeeLamports, 0n);
    assert.ok(structure.priorityFeeLamports <= 5_000_000n);
    assert.ok(structure.writable.length > 3);
    assert.ok(router.calls.some((call) => call.method === "getMultipleAccounts"), "lookup tables were resolved");
  });

  it("refuses the same blink when Jupiter is not allowlisted", async () => {
    await assert.rejects(check(fixtures.jupiterBlink.transaction, { programs: [NOOP], primaryProgram: NOOP }), refusedWith("PROGRAM_NOT_ALLOWED", /JUP6/u));
  });

  it("refuses transfer-sol: a System transfer to an undeclared third party", async () => {
    await assert.rejects(check(fixtures.transferSol.transaction, { programs: [NOOP], primaryProgram: NOOP }), refusedWith("ACTION_TRANSACTION_REJECTED", /undeclared third party \(nick6/u));
  });

  it("accepts the transfer to a declared payee within its cap (then needs the action's own program)", async () => {
    const payee = (maxLamports: string) => ({ payees: [{ address: NICK, maxLamports }], programs: [NOOP], primaryProgram: NOOP });
    await assert.rejects(check(fixtures.transferSol.transaction, payee("999999")), refusedWith("ACTION_TRANSACTION_REJECTED", /above its declared cap/u));
    await assert.rejects(check(fixtures.transferSol.transaction, payee("1000000")), refusedWith("ACTION_TRANSACTION_REJECTED", /does not invoke the action's program/u));
  });
});

describe("Solana Actions: structure rules", () => {
  const ok = [ix.computeUnits(200_000), ix.computePrice(1_000n), ix.program(ACME_PROGRAM, [SOL_OTHER])];

  it("accepts allowlisted programs with compute budget, memo, Lighthouse, ATA creation and SyncNative", async () => {
    const ata = randomAddress();
    const base64 = buildTransaction(SOL_USER, [...ok, ix.memo("hi"), ix.lighthouse(), ix.createAta(SOL_USER, ata, SOL_USER, USDC_MINT), ix.syncNative(ata), ix.closeAccount(ata, SOL_USER, SOL_USER), ix.initializeAccount3(ata, USDC_MINT, SOL_USER)]);
    const structure = await check(base64);
    assert.equal(structure.priorityFeeLamports, 200n);
  });

  it("refuses pre-signed transactions, extra signers and foreign fee payers", async () => {
    await assert.rejects(check(presign(buildTransaction(SOL_USER, ok))), refusedWith("ACTION_TRANSACTION_REJECTED", /pre-signed/u));
    const twoSigners = buildTransaction(SOL_USER, [...ok, ix.program(ACME_HELPER, [])].map((instruction, index) => index === 2 ? { ...instruction, accounts: [{ address: SOL_OTHER, role: "signer" as const }] } : instruction));
    await assert.rejects(check(twoSigners), refusedWith("ACTION_TRANSACTION_REJECTED", /more than the user's account/u));
    await assert.rejects(check(buildTransaction(SOL_OTHER, ok)), refusedWith("ACTION_TRANSACTION_REJECTED", /not fee-paid and signed solely/u));
  });

  it("refuses durable nonces, foreign programs and a missing primary program", async () => {
    await assert.rejects(check(buildTransaction(SOL_USER, [ix.advanceNonce(randomAddress(), SOL_USER), ...ok])), refusedWith("ACTION_TRANSACTION_REJECTED", /Durable-nonce/u));
    await assert.rejects(check(buildTransaction(SOL_USER, [...ok, ix.program(randomAddress())])), refusedWith("PROGRAM_NOT_ALLOWED", /not in the registration's program allowlist/u));
    await assert.rejects(check(buildTransaction(SOL_USER, [ix.program(ACME_HELPER)])), refusedWith("ACTION_TRANSACTION_REJECTED", /does not invoke the action's program/u));
  });

  it("restricts top-level System instructions", async () => {
    await assert.rejects(check(buildTransaction(SOL_USER, [...ok, ix.systemAssign(SOL_USER, ACME_PROGRAM)])), refusedWith("ACTION_TRANSACTION_REJECTED", /other than Transfer/u));
    await assert.rejects(check(buildTransaction(SOL_USER, [...ok, ix.systemTransfer(SOL_USER, SOL_OTHER, 1n)])), refusedWith("ACTION_TRANSACTION_REJECTED", /undeclared third party/u));
    const wsol = await wsolAccount();
    await assert.rejects(check(buildTransaction(SOL_USER, [ix.systemTransfer(SOL_USER, wsol, 10n), ...ok])), refusedWith("ACTION_TRANSACTION_REJECTED", /without a SyncNative/u));
    await check(buildTransaction(SOL_USER, [ix.systemTransfer(SOL_USER, wsol, 10n), ix.syncNative(wsol), ...ok]));
  });

  it("restricts top-level token and ATA instructions", async () => {
    const account = randomAddress();
    const cases = [
      [ix.tokenApprove(account, SOL_OTHER, SOL_USER), /token instruction other than/u],
      [ix.tokenSetAuthority(account, SOL_USER), /token instruction other than/u],
      [ix.tokenTransfer(account, randomAddress(), SOL_USER), /token instruction other than/u],
      [ix.closeAccount(account, SOL_OTHER, SOL_USER), /closes a token account to someone other/u],
      [ix.initializeAccount3(account, USDC_MINT, SOL_OTHER), /owned by someone other/u],
      [{ ...ix.createAta(SOL_OTHER, account, SOL_USER, USDC_MINT), accounts: ix.createAta(SOL_OTHER, account, SOL_USER, USDC_MINT).accounts?.map((entry, index) => (index === 0 ? { ...entry, role: "writable" as const } : entry)) }, /paid by another account/u],
      [ix.createAta(SOL_USER, account, SOL_USER, USDC_MINT, 2), /other than Create/u],
    ] as const;
    for (const [instruction, pattern] of cases) {
      await assert.rejects(check(buildTransaction(SOL_USER, [...ok, instruction])), refusedWith("ACTION_TRANSACTION_REJECTED", pattern), String(pattern));
    }
  });

  it("caps compute units, the priority fee, the heap frame and the transaction size", async () => {
    await assert.rejects(check(buildTransaction(SOL_USER, [ix.computeUnits(1_400_001), ix.program(ACME_PROGRAM)])), refusedWith("ACTION_TRANSACTION_REJECTED", /1,400,000 compute units/u));
    await assert.rejects(check(buildTransaction(SOL_USER, [ix.computeUnits(1_000_000), ix.computePrice(5_000_001n), ix.program(ACME_PROGRAM)])), refusedWith("ACTION_TRANSACTION_REJECTED", /priority fee/u));
    await assert.rejects(check(buildTransaction(SOL_USER, [ix.computePrice(4_000_000n), ix.program(ACME_PROGRAM)])), refusedWith("ACTION_TRANSACTION_REJECTED", /priority fee of 5600000/u));
    await assert.rejects(check(buildTransaction(SOL_USER, [ix.heapFrame(512 * 1024), ix.program(ACME_PROGRAM)])), refusedWith("ACTION_TRANSACTION_REJECTED", /heap frame/u));
    await assert.rejects(check(buildTransaction(SOL_USER, [ix.program(ACME_PROGRAM, [], Buffer.alloc(1_200, 1))])), refusedWith("ACTION_TRANSACTION_REJECTED", /bytes; the limit is 1232/u));
  });
});

async function wsolAccount(): Promise<string> {
  const { getProgramDerivedAddress, getAddressEncoder, address } = await import("@solana/kit");
  const [pda] = await getProgramDerivedAddress({
    programAddress: address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
    seeds: [getAddressEncoder().encode(address(SOL_USER)), getAddressEncoder().encode(address(TOKEN)), getAddressEncoder().encode(address(WRAPPED_SOL_MINT))],
  });
  return String(pda);
}

describe("Solana Actions: CPI scan", () => {
  const userAccount = randomAddress();
  const accounts = new Set([userAccount]);
  const inner = (program: string, data: number[] | null, accountsList: string[], parsed: SolanaInnerInstruction["parsed"] = null): SolanaInnerInstruction =>
    ({ index: 0, program, accounts: accountsList, data: data ? Uint8Array.from(data) : null, parsed });

  it("refuses approvals, authority changes and closes to others on the user's accounts, raw or parsed", () => {
    assert.match(innerInstructionRefusal([inner(TOKEN, [4, 1, 0, 0, 0, 0, 0, 0, 0], [userAccount, SOL_OTHER, SOL_USER])], SOL_USER, accounts) ?? "", /approves a delegate/u);
    assert.match(innerInstructionRefusal([inner(TOKEN, [13], [userAccount, USDC_MINT, SOL_OTHER, SOL_USER])], SOL_USER, accounts) ?? "", /approves a delegate/u);
    assert.match(innerInstructionRefusal([inner(TOKEN, [6, 2, 0], [userAccount, SOL_USER])], SOL_USER, accounts) ?? "", /changes an authority/u);
    assert.match(innerInstructionRefusal([inner(TOKEN, [9], [userAccount, SOL_OTHER, SOL_USER])], SOL_USER, accounts) ?? "", /closes the user's token account/u);
    assert.match(innerInstructionRefusal([inner(TOKEN, null, [], { type: "approveChecked", info: { source: userAccount, delegate: SOL_OTHER, owner: SOL_USER } })], SOL_USER, accounts) ?? "", /approves/u);
    assert.match(innerInstructionRefusal([inner(TOKEN, null, [], { type: "setAuthority", info: { account: randomAddress(), authority: SOL_USER } })], SOL_USER, accounts) ?? "", /authority/u);
  });

  it("refuses Assign / Allocate of the user's wallet and unreadable entries", () => {
    assert.match(innerInstructionRefusal([inner(SYSTEM, [1, 0, 0, 0], [SOL_USER])], SOL_USER, accounts) ?? "", /System Assign/u);
    assert.match(innerInstructionRefusal([inner(SYSTEM, [8, 0, 0, 0], [SOL_USER])], SOL_USER, accounts) ?? "", /System Allocate/u);
    assert.match(innerInstructionRefusal([inner(SYSTEM, null, [], { type: "assign", info: { account: SOL_USER, owner: ACME_PROGRAM } })], SOL_USER, accounts) ?? "", /assign/u);
    assert.match(innerInstructionRefusal([inner("", null, [])], SOL_USER, accounts) ?? "", /could not be read/u);
  });

  it("allows transfers signed by the user and moves of other accounts", () => {
    assert.equal(innerInstructionRefusal([
      inner(TOKEN, null, [], { type: "transfer", info: { source: userAccount, destination: randomAddress(), authority: SOL_USER, amount: "5" } }),
      inner(TOKEN, [4, 1, 0, 0, 0, 0, 0, 0, 0], [randomAddress(), SOL_OTHER, SOL_OTHER]),
      inner(SYSTEM, [1, 0, 0, 0], [randomAddress()]),
      inner(ACME_PROGRAM, [1], [userAccount]),
    ], SOL_USER, accounts), null);
  });
});

describe("Solana Actions: amount rules", () => {
  const base = { user: SOL_USER, payeeLamports: 0n, rentTolerance: 2_100_000n };

  it("holds SOL inputs to the amount within the rent tolerance and SPL inputs exactly", () => {
    const sol = { ...base, input: { mint: null, amount: 10_000_000n }, output: { mint: USDC_MINT } };
    const credited = new Map([[USDC_MINT, 1_000_000n]]);
    assert.equal(outcomeRefusal({ solDelta: -7_960_720n, tokenDeltas: credited, outputCredit: 1_000_000n }, sol), null, "live Jupiter blink: rent refund of a closed account");
    assert.match(outcomeRefusal({ solDelta: -12_200_000n, tokenDeltas: credited, outputCredit: 1_000_000n }, sol) ?? "", /spends 12200000 lamports/u);
    assert.match(outcomeRefusal({ solDelta: -10_000_000n, tokenDeltas: credited, outputCredit: 0n }, sol) ?? "", /not credited/u);
    const spl = { ...base, input: { mint: USDC_MINT, amount: 5n }, output: null };
    assert.equal(outcomeRefusal({ solDelta: -2_039_280n, tokenDeltas: new Map([[USDC_MINT, -5n]]), outputCredit: null }, spl), null);
    assert.match(outcomeRefusal({ solDelta: 0n, tokenDeltas: new Map([[USDC_MINT, -6n]]), outputCredit: null }, spl) ?? "", /not exactly -5/u);
    assert.match(outcomeRefusal({ solDelta: 0n, tokenDeltas: new Map(), outputCredit: null }, spl) ?? "", /does not debit the input/u);
    assert.match(outcomeRefusal({ solDelta: -3_000_000n, tokenDeltas: new Map([[USDC_MINT, -5n]]), outputCredit: null }, spl) ?? "", /beyond the fee/u);
    assert.match(outcomeRefusal({ solDelta: 0n, tokenDeltas: new Map([[USDC_MINT, -5n], [JUP6, -1n]]), outputCredit: null }, spl) ?? "", /another token/u);
  });

  it("counts declared payees apart from the step amount", () => {
    const sol = { ...base, input: { mint: null, amount: 10_000_000n }, output: null, payeeLamports: 5_000_000n };
    assert.equal(outcomeRefusal({ solDelta: -15_000_000n, tokenDeltas: new Map(), outputCredit: null }, sol), null);
  });
});

describe("Solana Actions: endpoints", () => {
  it("accepts transaction responses only", async () => {
    const answer = (json: unknown, status = 200) => new CannedTransport(() => ({ status, json }));
    const url = "https://actions.acme.example/api/stake?amount=1";
    assert.equal(await fetchActionTransaction(answer({ transaction: "AQAB", message: "hi" }), url, SOL_USER, {}), "AQAB");
    assert.equal(await fetchActionTransaction(answer({ type: "transaction", transaction: "AQAB" }), url, SOL_USER, {}), "AQAB");
    for (const json of [{ type: "message", data: "sign me" }, { type: "post", href: "/next" }, { type: "external-link", externalLink: "https://x.example" }, { transaction: "AQAB", links: { next: { type: "post", href: "/n" } } }]) {
      await assert.rejects(fetchActionTransaction(answer(json), url, SOL_USER, {}), refusedWith("ACTION_RESPONSE_UNSUPPORTED", /./u));
    }
    await assert.rejects(fetchActionTransaction(answer({ message: "nope" }), url, SOL_USER, {}), refusedWith("ACTION_RESPONSE_INVALID", /no transaction/u));
    await assert.rejects(fetchActionTransaction(answer(undefined), url, SOL_USER, {}), refusedWith("ACTION_RESPONSE_INVALID", /not a JSON object/u));
    await assert.rejects(fetchActionTransaction(answer({ message: "bad amount" }, 400), url, SOL_USER, {}), refusedWith("ACTION_RESPONSE_INVALID", /bad amount/u));
    await assert.rejects(fetchActionTransaction(answer({}, 503), url, SOL_USER, {}), refusedWith("ACTION_ENDPOINT_UNAVAILABLE", /HTTP 503/u));
    await assert.rejects(fetchActionTransaction(new CannedTransport(() => Promise.reject(new Error("socket"))), url, SOL_USER, {}), refusedWith("ACTION_ENDPOINT_UNAVAILABLE", /did not answer/u));
    const transport = answer({ transaction: "AQAB" });
    await fetchActionTransaction(transport, url, SOL_USER, { lockDays: "30" });
    assert.deepEqual(transport.requests[0]?.body, { account: SOL_USER, data: { lockDays: "30" } });
  });

  it("reads action metadata and checks the blockchain id", async () => {
    const transport = new CannedTransport((_method, url) => ({
      headers: { "X-Action-Version": "2.4.2", "x-blockchain-ids": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" },
      json: url.includes("bad") ? { label: "x" } : { title: "Buy USDC", label: "Buy", description: "Swap", icon: "https://x.example/i.png" },
    }));
    const metadata = await fetchSolanaActionMetadata(transport, "https://jupiter.dial.to/api/v0/swap/SOL-USDC/{amount}", "solana");
    assert.equal(metadata.url, "https://jupiter.dial.to/api/v0/swap/SOL-USDC");
    assert.equal(metadata.actionVersion, "2.4.2");
    assert.deepEqual(metadata.blockchainIds, ["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"]);
    await assert.rejects(fetchSolanaActionMetadata(transport, "https://jupiter.dial.to/bad", "solana"), refusedWith("ACTION_RESPONSE_INVALID", /title and a label/u));
    await assert.rejects(fetchSolanaActionMetadata(transport, "https://jupiter.dial.to/x", "solana-devnet"), refusedWith("ACTION_RESPONSE_UNSUPPORTED", /not solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/u));
  });

  it("fills and strips URL templates", () => {
    assert.equal(actionMetadataUrl(`https://solana-actions.vercel.app/api/actions/transfer-sol?to=${NICK}&amount={amount}`), `https://solana-actions.vercel.app/api/actions/transfer-sol?to=${NICK}`);
    assert.equal(fillActionHref("https://a.example/stake?amount={amount}&raw={amountBaseUnits}&lock={lockDays}", { amount: "1.5", amountBaseUnits: "1500000", params: { lockDays: 30 } }), "https://a.example/stake?amount=1.5&raw=1500000&lock=30");
    assert.equal(fillActionHref("https://a.example/{x}", { params: { x: "a/b" } }), "https://a.example/a%2Fb");
  });
});

describe("Solana Actions: payload binding", () => {
  it("replaces only the blockhash of legacy and v0 transactions", () => {
    for (const legacy of [true, false]) {
      const original = buildTransaction(SOL_USER, [ix.computeUnits(100_000), ix.program(ACME_PROGRAM, [SOL_OTHER])], { legacy });
      const next = withBlockhash(original, "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi");
      const decode = (base64: string) => getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(Buffer.from(base64, "base64")).messageBytes) as { lifetimeToken: string; instructions: unknown[]; staticAccounts: string[] };
      assert.equal(String(decode(next).lifetimeToken), "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi");
      assert.deepEqual(decode(next).instructions, decode(original).instructions);
      assert.deepEqual(decode(next).staticAccounts, decode(original).staticAccounts);
      assert.equal(Buffer.from(next, "base64").length, Buffer.from(original, "base64").length);
    }
  });

  it("binds instructions while tolerating compute-budget and Lighthouse additions", async () => {
    const prepared = buildTransaction(SOL_USER, [ix.computeUnits(100_000), ix.program(ACME_PROGRAM, [SOL_OTHER])]);
    const tuned = buildTransaction(SOL_USER, [ix.computeUnits(300_000), ix.computePrice(5n), ix.program(ACME_PROGRAM, [SOL_OTHER]), ix.lighthouse()]);
    const changed = buildTransaction(SOL_USER, [ix.computeUnits(100_000), ix.program(ACME_PROGRAM, [SOL_OTHER], Buffer.from([9]))]);
    const extra = buildTransaction(SOL_USER, [ix.program(ACME_PROGRAM, [SOL_OTHER]), ix.memo("x")]);
    const digest = async (base64: string) => actionInstructionDigest((await decodeSolanaTransaction("solana", base64)).instructions);
    assert.equal(await digest(tuned), await digest(prepared));
    assert.notEqual(await digest(changed), await digest(prepared));
    assert.notEqual(await digest(extra), await digest(prepared));
  });
});
