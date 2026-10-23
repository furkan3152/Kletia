/**
 * Strict path look-alike symbols (design A.10, C.5): a Solana symbol of a
 * look-alike family that Kletia does not list ("wsol", "bsol") is refused by
 * the grammar instead of being searched for by name, where a search could
 * return the listed sibling or an unrelated token. Listed symbols, reviewed
 * aliases and EVM symbols keep their existing handling.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compileIntentText } from "../grammar.js";
import { isPlatformError } from "../../errors.js";

function refusal(text: string): string {
  try {
    compileIntentText(text);
  } catch (error) {
    assert.ok(isPlatformError(error), String(error));
    assert.equal(error.code, "INTENT_UNSUPPORTED");
    return error.message;
  }
  assert.fail(`"${text}" compiled`);
}

describe("strict path look-alike symbols", () => {
  it("refuses wSOL and bSOL on either side, naming the listed tokens", () => {
    assert.match(refusal("swap 1 wsol to usdc on solana"), /"wsol" is not a token Kletia lists on Solana.*Kletia lists SOL/u);
    assert.match(refusal("swap 10 usdc to wsol on solana"), /"wsol" is not a token Kletia lists on Solana/u);
    assert.match(refusal("swap 2 bsol to sol on solana"), /"bsol" is not a token Kletia lists on Solana/u);
  });

  it("keeps listed symbols, reviewed aliases and EVM symbols", () => {
    assert.equal(compileIntentText("swap 1 sol to usdc on solana").actions[0]?.from?.toLowerCase(), "sol");
    assert.equal(compileIntentText("swap 1 sol to jitosol on solana").actions[0]?.to?.toLowerCase(), "jitosol");
    assert.equal(compileIntentText("swap 100 usdc to usdt on arbitrum").actions[0]?.network, "arbitrum");
  });
});
