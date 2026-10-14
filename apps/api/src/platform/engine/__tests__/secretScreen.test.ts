/**
 * Secret screen: createIntentDetailed refuses free text carrying a private
 * key, a seed phrase, a PEM key or a bearer credential with 400
 * MESSAGE_SECRET_REFUSED before anything is planned or stored, on every
 * path that reaches it (POST /v1/intents, MCP, links, sessions), and
 * planning without creating refuses it too. The rules agree with the web
 * screen on packages/core/test/fixtures/secret-vectors.json.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, describe, it } from "node:test";
import { PlatformError } from "../../errors.js";
import { planIntent } from "../planner.js";
import { assertNoSecret, containsSecret, SECRET_REFUSED_MESSAGE } from "../secretScreen.js";
import { createIntentDetailed } from "../service.js";
import type { MemoryIntentStore } from "../store.js";
import { ACCOUNTS, resetEngine, stub } from "./helpers.js";

interface Vector {
  readonly case: string;
  readonly text: string;
}

const vectors = JSON.parse(readFileSync(new URL("../../../../../../packages/core/test/fixtures/secret-vectors.json", import.meta.url), "utf8")) as {
  readonly refuse: readonly Vector[];
  readonly allow: readonly Vector[];
};

describe("secret screen: shared vectors", () => {
  for (const vector of vectors.refuse) {
    it(`refuses: ${vector.case}`, () => {
      assert.equal(containsSecret(vector.text), true);
      assert.throws(() => assertNoSecret(vector.text), (error: unknown) =>
        error instanceof PlatformError && error.code === "MESSAGE_SECRET_REFUSED" && error.status === 400 && !error.message.includes(vector.text.slice(0, 12)));
    });
  }
  for (const vector of vectors.allow) {
    it(`allows: ${vector.case}`, () => {
      assert.equal(containsSecret(vector.text), false);
      assert.doesNotThrow(() => assertNoSecret(vector.text));
    });
  }
});

describe("secret screen: createIntentDetailed", () => {
  let store: MemoryIntentStore;
  const KEY = "0x1111111111111111111111111111111111111111111111111111111111111111";
  const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

  beforeEach(() => {
    store = resetEngine();
  });

  async function refused(promise: Promise<unknown>): Promise<PlatformError> {
    try {
      await promise;
    } catch (error) {
      assert.ok(error instanceof PlatformError);
      return error;
    }
    assert.fail("expected a refusal");
  }

  it("refuses a private key or a seed phrase in the text before planning or storing anything", async () => {
    for (const text of [`swap 1 SOL to USDC ${KEY}`, `send 5 USDC to 9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM ${MNEMONIC}`]) {
      const calls = stub.calls.prepare;
      const error = await refused(createIntentDetailed({ text, accounts: ACCOUNTS, clientReference: "secret-1" }, { ownerKeyId: "key_a" }));
      assert.equal(error.code, "MESSAGE_SECRET_REFUSED");
      assert.equal(error.status, 400);
      assert.equal(error.message, SECRET_REFUSED_MESSAGE);
      assert.deepEqual(error.issues?.map((entry) => entry.path), ["text"]);
      assert.ok(!JSON.stringify(error.toJSON()).includes(KEY.slice(2, 20)), "the refusal never repeats the secret");
      assert.equal(stub.calls.prepare, calls);
    }
    assert.deepEqual(await store.listByOwner("key_a", 10), [], "nothing was stored");
  });

  it("refuses dry runs and invalid requests with a secret the same way (screen first)", async () => {
    const dry = await refused(createIntentDetailed({ text: `swap 1 SOL to USDC ${KEY}`, accounts: ACCOUNTS }, { dryRun: true, preview: true }));
    assert.equal(dry.code, "MESSAGE_SECRET_REFUSED");
    const invalid = await refused(createIntentDetailed({ text: MNEMONIC, accounts: ["not-an-account"] }));
    assert.equal(invalid.code, "MESSAGE_SECRET_REFUSED", "before validation, so nothing about the request is echoed");
  });

  it("refuses a secret when planning without creating (policy evaluate)", async () => {
    const error = await refused(planIntent({ text: `swap 1 SOL to USDC Bearer FAKEFAKEFAKEFAKE`, accounts: ACCOUNTS }));
    assert.equal(error.code, "MESSAGE_SECRET_REFUSED");
  });

  it("plans ordinary text unchanged", async () => {
    const created = await createIntentDetailed({ text: "swap 1 SOL to USDC please", accounts: ACCOUNTS });
    assert.equal(created.intent.steps[0]?.protocol, "jupiter");
  });
});
