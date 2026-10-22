// Injected wallet discovery and message signing of the developer portal sign-in
// (keys/injectedWallets.ts), against fake EIP-6963 and Wallet Standard wallets. Run with Node 22.18 or later:
//   node --test apps/web/src/app/pages/developers/keys/__tests__/injectedWallets.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

const fakeWindow = new EventTarget();
fakeWindow.setTimeout = (callback, ms) => setTimeout(callback, ms);
globalThis.window = fakeWindow;

const { connectWallet, discoverEvmWallets, discoverSolanaWallets, signWithWallet } = await import("../injectedWallets.ts");

test("finds EIP-6963 wallets and signs plain text with personal_sign only", async () => {
  const calls = [];
  const provider = {
    request: async ({ method, params }) => {
      calls.push({ method, params });
      if (method === "eth_requestAccounts") return ["0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"];
      if (method === "eth_chainId") return "0xa4b1";
      if (method === "personal_sign") return `0x${"11".repeat(65)}`;
      throw new Error(`unexpected ${method}`);
    },
  };
  const announce = () => fakeWindow.dispatchEvent(Object.assign(new Event("eip6963:announceProvider"), { detail: { info: { uuid: "u-1", name: "Test Wallet" }, provider } }));
  fakeWindow.addEventListener("eip6963:requestProvider", announce);
  const wallets = await discoverEvmWallets(5);
  fakeWindow.removeEventListener("eip6963:requestProvider", announce);
  assert.deepEqual(wallets.map((wallet) => [wallet.kind, wallet.name]), [["evm", "Test Wallet"]]);
  const connected = await connectWallet(wallets[0]);
  assert.deepEqual(connected, { address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", chainId: 42161 });
  const signature = await signWithWallet(wallets[0], connected, "hé", () => "");
  assert.equal(signature, `0x${"11".repeat(65)}`);
  assert.deepEqual(calls.at(-1), { method: "personal_sign", params: ["0x68c3a9", connected.address] });
  assert.deepEqual(calls.map((call) => call.method), ["eth_requestAccounts", "eth_chainId", "personal_sign"]);
});

test("finds Solana wallets through the Wallet Standard events and keeps only message signers", async () => {
  const account = { address: "D2Ts7yCiVjedo6uwqpkM44QA8J45NdVU1J3k5m6iWtvm", chains: ["solana:mainnet"] };
  const signer = {
    name: "Sol Wallet",
    chains: ["solana:mainnet"],
    accounts: [],
    features: {
      "standard:connect": { connect: async () => ({ accounts: [account] }) },
      "solana:signMessage": { signMessage: async ({ message }) => [{ signature: new Uint8Array(64).fill(message.length) }] },
    },
  };
  const viewer = { name: "No Signing", chains: ["solana:mainnet"], features: { "standard:connect": { connect: async () => ({ accounts: [] }) } } };
  const evmOnly = { name: "EVM Standard", chains: ["eip155:1"], features: { "standard:connect": {}, "solana:signMessage": {} } };
  fakeWindow.addEventListener("wallet-standard:app-ready", (event) => event.detail.register(signer, viewer, evmOnly), { once: true });
  const wallets = discoverSolanaWallets();
  assert.deepEqual(wallets.map((wallet) => wallet.name), ["Sol Wallet"]);
  const connected = await connectWallet(wallets[0]);
  assert.equal(connected.address, account.address);
  const signature = await signWithWallet(wallets[0], connected, "abc", (bytes) => `b58:${bytes.length}:${bytes[0]}`);
  assert.equal(signature, "b58:64:3");
});

test("refuses wallets that return no account or no signature", async () => {
  const empty = { kind: "evm", id: "x", name: "x", provider: { request: async () => [] } };
  await assert.rejects(connectWallet(empty), /no account/u);
  const silent = { kind: "evm", id: "y", name: "y", provider: { request: async () => null } };
  await assert.rejects(signWithWallet(silent, { address: "0x0" }, "m", () => ""), /no signature/u);
});
