/**
 * Model-assisted reading over HTTP (design A.7.6, P5): no reader without the
 * switch, eligibility and consent; session consent covers typed desk text
 * only; single-use tokens; server keys never mint consent; a confirm token
 * makes the turn's authority "token".
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { Request } from "express";
import { issueReadingConsentToken } from "../../../shared/intent/semanticConsent.js";
import { configureReadingLayer, ReadingLayer } from "../../engine/reading/index.js";
import { scriptedProvider } from "../../engine/reading/scripted.js";
import { setAuth } from "../context.js";
import { mintReadingConsent, readingAccess } from "../reading.js";
import { kletiaWebOrigin } from "../webOrigin.js";

const WALLET = "0x2222222222222222222222222222222222222222";
const ACCOUNT = `eip155:8453:${WALLET}`;
const TEXT = "into eth swap my 5 usdc on base";

function fakeReq(body: unknown, origin?: string): Request {
  return { body, get: (name: string) => (name.toLowerCase() === "origin" ? origin : undefined), query: {} } as unknown as Request;
}

function install(switchValue: "on" | "off") {
  const provider = scriptedProvider(() => '{"verdict":"unclear"}');
  configureReadingLayer(new ReadingLayer({ config: { switch: switchValue, profiles: [{ model: "a/x", provider: "p" }, { model: "b/y", provider: "q" }] }, provider, log: () => undefined }));
  return provider;
}

after(() => configureReadingLayer(null));

describe("reading access", () => {
  it("the switch off gives no reader and nothing available, whatever the request says", async () => {
    install("off");
    const token = issueReadingConsentToken({ scope: "once", wallet: WALLET, text: TEXT }).token;
    const access = await readingAccess(fakeReq({ accounts: [ACCOUNT], text: TEXT, modelReading: "on", consent: token }, kletiaWebOrigin()), {
      accounts: [ACCOUNT], text: TEXT, modelReading: "on", consent: token,
    });
    assert.equal(access.reader, undefined);
    assert.equal(access.available, false);
  });

  it("the desk: available without consent, a reader with a once token (single use), session only for typed text", async () => {
    install("on");
    const desk = kletiaWebOrigin();
    const plain = await readingAccess(fakeReq(null, desk), { accounts: [ACCOUNT], text: TEXT });
    assert.equal(plain.available, true);
    assert.equal(plain.reader, undefined);
    const once = issueReadingConsentToken({ scope: "once", wallet: WALLET, text: TEXT }).token;
    const body = { accounts: [ACCOUNT], text: TEXT, modelReading: "on", consent: once };
    assert.ok((await readingAccess(fakeReq(body, desk), body)).reader);
    assert.equal((await readingAccess(fakeReq(body, desk), body)).reader, undefined, "a once token is single use");
    const other = { ...body, text: "swap 9 usdc", consent: issueReadingConsentToken({ scope: "once", wallet: WALLET, text: TEXT }).token };
    assert.equal((await readingAccess(fakeReq(other, desk), other)).reader, undefined, "bound to its text");
    const session = issueReadingConsentToken({ scope: "session", wallet: WALLET }).token;
    const prefilled = { accounts: [ACCOUNT], text: TEXT, modelReading: "on", consent: session };
    assert.equal((await readingAccess(fakeReq(prefilled, desk), prefilled)).reader, undefined, "session consent needs typed text");
    const typed = { ...prefilled, textOrigin: "typed" };
    assert.ok((await readingAccess(fakeReq(typed, desk), typed)).reader);
  });

  it("the public tier from another origin never gets it", async () => {
    install("on");
    const once = issueReadingConsentToken({ scope: "once", wallet: WALLET, text: TEXT }).token;
    const body = { accounts: [ACCOUNT], text: TEXT, modelReading: "on", consent: once };
    const access = await readingAccess(fakeReq(body, "https://evil.example"), body);
    assert.equal(access.reader, undefined);
    assert.equal(access.available, false);
  });

  it("a confirm token bound to the thread gives token authority; anything else is api", async () => {
    install("on");
    const confirm = issueReadingConsentToken({ scope: "confirm", wallet: WALLET, threadId: "th_aaaaaaaaaaaaaaaaaaaaaaaa" }).token;
    const body = { accounts: [ACCOUNT], thread: { id: "th_aaaaaaaaaaaaaaaaaaaaaaaa" }, answer: { question: "q.actions.0.kind", option: "confirm" }, consent: confirm };
    assert.equal((await readingAccess(fakeReq(body, kletiaWebOrigin()), body)).confirmAuthority, "token");
    const wrong = { ...body, thread: { id: "th_bbbbbbbbbbbbbbbbbbbbbbbb" } };
    assert.equal((await readingAccess(fakeReq(wrong, kletiaWebOrigin()), wrong)).confirmAuthority, "api");
    const keyed = fakeReq(body, kletiaWebOrigin());
    setAuth(keyed, { tier: "developer" as never, keyId: "key_1", keyKind: "agent" });
    assert.equal((await readingAccess(keyed, body)).confirmAuthority, "api", "a server key never confirms for the person");
  });

  it("server keys cannot mint consent; the desk can", async () => {
    install("on");
    const keyed = fakeReq({ scope: "confirm", wallet: WALLET, threadId: "th_a" }, kletiaWebOrigin());
    setAuth(keyed, { tier: "developer" as never, keyId: "key_1", keyKind: "project", projectId: "prj_1" });
    await assert.rejects(mintReadingConsent(keyed), (error: { code?: string }) => error.code === "CONFIRM_AUTHORITY_REQUIRED");
    const minted = await mintReadingConsent(fakeReq({ scope: "once", wallet: WALLET, text: TEXT }, kletiaWebOrigin()));
    assert.equal(minted.scope, "once");
    await assert.rejects(mintReadingConsent(fakeReq({ scope: "session", wallet: WALLET }, "https://evil.example")));
  });
});
