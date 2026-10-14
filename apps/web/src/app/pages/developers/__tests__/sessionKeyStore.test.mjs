// The portal's in-memory key store (keys/sessionKeyStore.ts). Run with Node 22.18 or later:
//   node --test apps/web/src/app/pages/developers/__tests__/sessionKeyStore.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

// Fake browser persistence that records every touch, installed before the store loads.
const touched = [];
function recorder(name) {
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property === "symbol") return undefined;
        touched.push(`${name}.${property}`);
        return () => undefined;
      },
      set(_target, property) {
        touched.push(`${name}.${String(property)}=`);
        return true;
      },
    },
  );
}
const fakeDocument = {
  get cookie() {
    touched.push("document.cookie");
    return "";
  },
  set cookie(_value) {
    touched.push("document.cookie=");
  },
  get title() {
    touched.push("document.title");
    return "";
  },
  set title(_value) {
    touched.push("document.title=");
  },
};
const fakes = {
  localStorage: recorder("localStorage"),
  sessionStorage: recorder("sessionStorage"),
  indexedDB: recorder("indexedDB"),
  history: recorder("history"),
  location: recorder("location"),
  document: fakeDocument,
};
for (const [name, value] of Object.entries(fakes)) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
Object.defineProperty(globalThis, "window", { value: { ...fakes }, configurable: true, writable: true });

const { clearSessionKey, getSessionKey, setSessionKey, subscribeSessionKey } = await import("../keys/sessionKeyStore.ts");

const DEV_KEY = `kl_dev_${"a1B2".repeat(8)}`;
const AGENT_KEY = `kl_agt_${"Z9y8".repeat(8)}`;

test("starts empty, trims what it is given and notifies subscribers once per change", () => {
  clearSessionKey();
  assert.equal(getSessionKey(), "");
  const seen = [];
  const stop = subscribeSessionKey(() => seen.push(getSessionKey()));
  setSessionKey(`  ${DEV_KEY}\n`);
  assert.equal(getSessionKey(), DEV_KEY);
  setSessionKey(DEV_KEY);
  assert.deepEqual(seen, [DEV_KEY], "setting the same key again is not a change");
  clearSessionKey();
  assert.equal(getSessionKey(), "");
  assert.deepEqual(seen, [DEV_KEY, ""]);
  stop();
  setSessionKey(AGENT_KEY);
  assert.deepEqual(seen, [DEV_KEY, ""], "an unsubscribed listener hears nothing");
  clearSessionKey();
});

test("the key survives a route change: the old page unsubscribes, the next page still reads it", () => {
  clearSessionKey();
  const shell = [];
  const keysPage = [];
  const stopShell = subscribeSessionKey(() => shell.push(getSessionKey()));
  const stopKeysPage = subscribeSessionKey(() => keysPage.push(getSessionKey()));
  setSessionKey(DEV_KEY);
  assert.deepEqual(shell, [DEV_KEY]);
  assert.deepEqual(keysPage, [DEV_KEY]);
  // Leaving the page (and even the whole portal) only unsubscribes; nothing clears the key.
  stopKeysPage();
  stopShell();
  assert.equal(getSessionKey(), DEV_KEY);
  const studioDetour = subscribeSessionKey(() => undefined);
  studioDetour();
  const contractsPage = [];
  const stopContracts = subscribeSessionKey(() => contractsPage.push(getSessionKey()));
  assert.equal(getSessionKey(), DEV_KEY, "coming back to /developers finds the key still in memory");
  clearSessionKey();
  assert.deepEqual(contractsPage, [""], "Forget key reaches the page that is mounted now");
  stopContracts();
});

test("anything that is not a string clears the key instead of storing it", () => {
  setSessionKey(DEV_KEY);
  setSessionKey(undefined);
  assert.equal(getSessionKey(), "");
  setSessionKey(DEV_KEY);
  setSessionKey({ toString: () => DEV_KEY });
  assert.equal(getSessionKey(), "");
});

test("never touches storage, cookies, the URL, history or the title", () => {
  setSessionKey(DEV_KEY);
  setSessionKey(AGENT_KEY);
  const stop = subscribeSessionKey(() => getSessionKey());
  clearSessionKey();
  stop();
  assert.deepEqual(touched, []);
});
