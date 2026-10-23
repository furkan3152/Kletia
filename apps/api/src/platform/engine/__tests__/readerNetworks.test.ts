/**
 * Network words in the reader:
 *
 * - Networks Kletia does not run on, and lane qualifiers it has no lane for
 *   ("arbitrum nova", "base sepolia", "solana testnet", "arc mainnet"),
 *   refuse NETWORK_UNSUPPORTED naming the phrase, in the clarify reader and
 *   in the strict grammar; never read as the supported network next to them.
 * - Supported qualified names still read ("arbitrum sepolia", "solana
 *   devnet", "base mainnet", "arc testnet").
 * - Words inside a name ("ink.eth", "nova.sol") are not networks.
 * - "mainnet" / "l1" alone are Ethereum only for an EVM-family clause;
 *   "on eth" after the clause's token is Ethereum.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { UNSUPPORTED_NETWORKS } from "@kletia/core";
import { contextFor, installWallet, loadCorpus, runTurn, uninstallWallet, type CorpusCase } from "../clarify/corpusHarness.js";
import { parseSentence } from "../clarify/slots.js";
import type { WorkStep } from "../clarify/types.js";
import { compileIntentText } from "../grammar.js";
import { isPlatformError, type PlatformError } from "../../errors.js";

const corpus = loadCorpus(fileURLToPath(new URL("./fixtures/clarify-corpus.json", import.meta.url)));
const contextOf = (wallet: string) => contextFor(corpus, { id: "t", category: "test", title: "t", wallet, turns: [] } as unknown as CorpusCase);
after(() => uninstallWallet());

function refusal(run: () => unknown): PlatformError {
  try {
    run();
  } catch (error) {
    if (isPlatformError(error)) return error;
    throw error;
  }
  assert.fail("expected a refusal");
}

const first = (text: string) => parseSentence(text, []).steps[0] as WorkStep;

describe("unsupported networks and lane qualifiers refuse NETWORK_UNSUPPORTED", () => {
  for (const [text, name] of [
    ["bridge 10 usdc from base to arbitrum nova", "Arbitrum Nova"],
    ["bridge 10 usdc from arbitrum to base sepolia", "Base Sepolia"],
    ["swap 0.1 sol to usdc on solana testnet", "Solana Testnet"],
    ["bridge 5 usdc to arc mainnet", "Arc Mainnet"],
    ["bridge 10 usdc from base to linea", "Linea"],
    ["swap 1 eth to usdc on zksync", "zkSync Era"],
    ["bridge 20 usdc to bsc", "BNB Smart Chain"],
    ["send 5 usdc to vitalik.eth on avalanche", "Avalanche"],
    ["bridge 10 usdc from base to scroll", "Scroll"],
    ["move 10 usdc to blast", "Blast"],
    ["bridge 1 eth from ethereum to ink", "Ink"],
    ["swap 1 eth to usdc on ethereum goerli", "Ethereum Goerli"],
    ["bridge usdc from polygon zkevm to base", "Polygon zkEVM"],
  ] as const) {
    it(`"${text}" -> Kletia does not run on ${name}`, async () => {
      const error = refusal(() => parseSentence(text, []));
      assert.equal(error.code, "NETWORK_UNSUPPORTED", `${text}: ${error.message}`);
      assert.match(error.message, new RegExp(`^Kletia does not run on ${name}\\. It runs on Base, Arbitrum One, Ethereum, OP Mainnet, Polygon PoS and Solana`, "u"));
      // The strict grammar says the same.
      const strict = refusal(() => compileIntentText(text));
      assert.equal(strict.code, "NETWORK_UNSUPPORTED", text);
      // And a turn never plans it on the supported network next to the word.
      installWallet(corpus, "full");
      const run = await runTurn(null, { text }, contextOf("full"));
      assert.equal(run.decision, undefined);
      assert.equal(run.error?.code, "NETWORK_UNSUPPORTED");
    });
  }

  it("a common word that names a network counts only in a network position", () => {
    for (const text of ["swap 1 sol to usdc era", "swap 1 sol to usdc and scroll"]) {
      try {
        parseSentence(text, []);
      } catch (error) {
        assert.ok(isPlatformError(error) && error.code !== "NETWORK_UNSUPPORTED", `${text}: ${String(error)}`);
      }
    }
  });

  it("every listed unsupported phrase refuses in a network position", () => {
    for (const phrase of Object.keys(UNSUPPORTED_NETWORKS)) {
      const error = refusal(() => parseSentence(`bridge 10 usdc from base to ${phrase}`, []));
      assert.equal(error.code, "NETWORK_UNSUPPORTED", phrase);
    }
  });
});

describe("supported qualified names still read", () => {
  for (const [text, network] of [
    ["bridge 5 usdc from arbitrum sepolia to solana devnet", "arbitrum-sepolia"],
    ["swap 1 eth to usdc on base mainnet", "base"],
    ["swap 1 sol to usdc on solana mainnet", "solana"],
  ] as const) {
    it(`"${text}" reads ${network}`, () => {
      assert.equal(first(text).network?.v, network);
    });
  }

  it("a word inside a name is no network (\"ink.eth\", \"nova.sol\", \"blast-fund.eth\")", () => {
    for (const text of ["send 10 usdc to ink.eth on base", "send 1 sol to nova.sol", "send 10 usdc to blast-fund.eth on base"]) {
      assert.equal(first(text).recipient?.v, /\bto (\S+)/u.exec(text)?.[1], text);
    }
  });
});

describe("\"mainnet\", \"l1\" and \"on eth\"", () => {
  for (const text of ["send 0.01 eth to alice.eth on mainnet", "send 0.01 eth to vitalik.eth on l1", "swap 1 eth to usdc on mainnet", "bridge 0.1 eth from base to mainnet"]) {
    it(`"${text}" reads Ethereum (the clause is EVM-family)`, () => {
      const steps = parseSentence(text, []).steps;
      assert.ok(steps.some((step) => step.network?.v === "ethereum" || step.toNetwork?.v === "ethereum"), JSON.stringify(steps));
    });
  }

  for (const text of ["swap 1 sol to usdc on mainnet", "send 10 usdc to carol.sns on mainnet", "swap 10 usdc to usdt on l1"]) {
    it(`"${text}" is not read (Solana-family or unknown family: never guessed)`, () => {
      const error = refusal(() => parseSentence(text, []));
      assert.equal(error.code, "INTENT_UNSUPPORTED", text);
    });
  }

  it("\"on eth\" after the clause's token is Ethereum the network", () => {
    const step = first("swap 1 eth to usdc on eth");
    assert.equal(step.network?.v, "ethereum");
    assert.equal(step.from?.v.toUpperCase(), "ETH");
    assert.equal(step.to?.v.toUpperCase(), "USDC");
  });
});
