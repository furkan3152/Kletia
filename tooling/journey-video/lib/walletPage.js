// Page side of the "Kletia Test Wallet" (added as a Playwright init script).
// It announces an EIP-1193 provider over EIP-6963 and registers a Wallet
// Standard Solana wallet, so the app's own "Connect wallet" flows list it like
// a browser extension. Every request that needs consent opens a small wallet
// popup in the page (what is being signed, Reject / Approve); the journey
// script clicks Approve with the visible cursor. Keys never enter the page:
// reads and signatures go through the `__klWalletBridge` binding to the
// harness, which signs in memory and talks to the local forks only.
// Also draws the visible cursor and the caption lower-third used by the video.
(function installKletiaTestWallet(config) {
  if (window.top !== window || window.__klTestWallet) return;
  window.__klTestWallet = true;

  const NAME = "Kletia Test Wallet";
  const ICON =
    "data:image/svg+xml;base64," +
    btoa(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#FF6A3D"/><path d="M16 22h32v24H16z" fill="#fff"/><path d="M38 30h12v8H38z" fill="#1A1A1A"/><circle cx="43" cy="34" r="2" fill="#FF6A3D"/></svg>',
    );
  const CHAIN_NAMES = config.chainNames;
  const bridge = async (payload) => {
    try {
      return await window.__klWalletBridge(payload);
    } catch (error) {
      const text = String(error?.message ?? error);
      const start = text.indexOf('{"code"');
      if (start < 0) throw error;
      const parsed = JSON.parse(text.slice(start, text.lastIndexOf("}") + 1));
      throw rpcError(parsed.code, parsed.message);
    }
  };

  /* ---------- overlay layer (shadow DOM: the app's styles never reach it) ---------- */
  let shadow = null;
  function layer() {
    if (shadow) return shadow;
    const host = document.createElement("div");
    host.id = "kl-journey-layer";
    host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
    (document.body ?? document.documentElement).appendChild(host);
    shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>
      :host{all:initial}
      .cursor{position:fixed;left:0;top:0;width:22px;height:22px;transform:translate(-3px,-2px);transition:transform .02s;filter:drop-shadow(0 2px 3px rgba(0,0,0,.45));}
      .cursor.down svg{transform:scale(.85)}
      .ripple{position:fixed;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:3px solid #FF6A3D;animation:rp .5s ease-out forwards}
      @keyframes rp{from{opacity:1;transform:scale(.4)}to{opacity:0;transform:scale(1.6)}}
      .caption{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);max-width:min(92vw,980px);background:rgba(12,14,22,.92);color:#fff;font:600 17px/1.35 system-ui,-apple-system,Segoe UI,sans-serif;padding:10px 18px 11px;border-left:5px solid #FF6A3D;border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,.35);opacity:0;transition:opacity .25s}
      .caption.on{opacity:1}
      .caption small{display:block;font-weight:500;font-size:13px;color:#FFC9B5;letter-spacing:.04em;text-transform:uppercase;margin-bottom:2px}
      .caption.fork{border-left-color:#F5B700}
      .card{position:fixed;inset:0;background:#FF6A3D;color:#fff;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:14px;text-align:center;padding:24px;font:800 40px/1.15 system-ui,-apple-system,Segoe UI,sans-serif}
      .flash{position:fixed;left:0;top:0;width:16px;height:16px;background:#FF6A3D}
      .card small{font:600 18px/1.4 system-ui,sans-serif;max-width:760px;opacity:.95}
      .popup{position:fixed;top:64px;right:18px;width:340px;max-width:calc(100vw - 24px);background:#fff;color:#111;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.45);font:14px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;pointer-events:auto;overflow:hidden;animation:pop .18s ease-out}
      @keyframes pop{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:none}}
      .popup header{display:flex;align-items:center;gap:10px;padding:12px 14px;background:#1A1A1A;color:#fff}
      .popup header img{width:26px;height:26px;border-radius:6px}
      .popup header b{font-size:14px}
      .popup header span{margin-left:auto;font-size:11px;background:#F5B700;color:#111;padding:2px 7px;border-radius:99px;font-weight:700}
      .popup .body{padding:14px}
      .popup h3{margin:0 0 6px;font-size:16px}
      .popup dl{margin:8px 0 0;display:grid;grid-template-columns:auto 1fr;gap:4px 10px;font-size:12.5px}
      .popup dt{color:#666}
      .popup dd{margin:0;font-family:ui-monospace,Menlo,monospace;word-break:break-all;max-height:84px;overflow:hidden}
      .popup .actions{display:flex;gap:10px;padding:0 14px 14px}
      .popup button{flex:1;height:40px;border-radius:10px;border:2px solid #1A1A1A;font:700 14px system-ui,sans-serif;cursor:pointer}
      .popup .approve{background:#FF6A3D;border-color:#FF6A3D;color:#fff}
      .popup .reject{background:#fff;color:#1A1A1A}
      .popup .note{font-size:11.5px;color:#7a5b00;background:#FFF6D6;padding:6px 14px}
    </style><div class="caption" id="caption"></div>`;
    return shadow;
  }

  /* ---------- visible cursor ---------- */
  function installCursor() {
    const root = layer();
    const cursor = document.createElement("div");
    cursor.className = "cursor";
    cursor.innerHTML =
      '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M3 2l7 19 2.6-7.6L20 11z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    root.appendChild(cursor);
    const at = (event) => {
      cursor.style.transform = `translate(${event.clientX - 3}px, ${event.clientY - 2}px)`;
    };
    window.addEventListener("mousemove", at, true);
    window.addEventListener("pointermove", at, true);
    window.addEventListener(
      "mousedown",
      (event) => {
        cursor.classList.add("down");
        const ripple = document.createElement("div");
        ripple.className = "ripple";
        ripple.style.left = `${event.clientX}px`;
        ripple.style.top = `${event.clientY}px`;
        root.appendChild(ripple);
        setTimeout(() => ripple.remove(), 600);
      },
      true,
    );
    window.addEventListener("mouseup", () => cursor.classList.remove("down"), true);
  }

  window.__klCaption = (title, text, fork) => {
    const node = layer().getElementById("caption");
    if (!text) {
      node.classList.remove("on");
      return;
    }
    node.className = "caption on" + (fork ? " fork" : "");
    node.innerHTML = "";
    const small = document.createElement("small");
    small.textContent = title;
    node.append(small, document.createTextNode(text));
  };

  /** Full-screen title card (also the video's sync marker: a flat #FF6A3D frame). */
  window.__klCard = (title, subtitle) => {
    const root = layer();
    root.getElementById("kl-card")?.remove();
    if (!title) return;
    const card = document.createElement("div");
    card.className = "card";
    card.id = "kl-card";
    const small = document.createElement("small");
    small.textContent = subtitle ?? "";
    card.append(document.createTextNode(title), small);
    root.appendChild(card);
  };

  /** A 16 px corner flash in the card colour: the chapter mark the encoder looks for. */
  window.__klFlash = () => {
    const flash = document.createElement("div");
    flash.className = "flash";
    layer().appendChild(flash);
    setTimeout(() => flash.remove(), 600);
  };

  /* ---------- wallet popup ---------- */
  let pending = Promise.resolve();
  function popup(title, rows, note) {
    const run = () =>
      new Promise((resolve) => {
        const root = layer();
        const box = document.createElement("div");
        box.className = "popup";
        box.id = "kl-wallet-popup";
        box.setAttribute("role", "dialog");
        box.innerHTML = `<header><img alt=""><b></b><span>LOCAL FORK</span></header><div class="body"><h3></h3><dl></dl></div><div class="actions"><button class="reject" type="button">Reject</button><button class="approve" type="button">Approve</button></div>`;
        box.querySelector("img").src = ICON;
        box.querySelector("header b").textContent = NAME;
        box.querySelector("h3").textContent = title;
        const list = box.querySelector("dl");
        for (const [key, value] of rows) {
          const dt = document.createElement("dt");
          dt.textContent = key;
          const dd = document.createElement("dd");
          dd.textContent = String(value);
          list.append(dt, dd);
        }
        if (note) {
          const n = document.createElement("div");
          n.className = "note";
          n.textContent = note;
          box.insertBefore(n, box.querySelector(".actions"));
        }
        const done = (ok) => {
          box.remove();
          window.__klWalletOpen = null;
          resolve(ok);
        };
        box.querySelector(".approve").addEventListener("click", () => done(true));
        box.querySelector(".reject").addEventListener("click", () => done(false));
        root.appendChild(box);
        window.__klWalletOpen = { title, rows };
      });
    const result = pending.then(run, run);
    pending = result.catch(() => undefined);
    return result;
  }
  window.__klWalletPopupRect = (which) => {
    const box = shadow?.getElementById("kl-wallet-popup");
    const button = box?.querySelector(which === "reject" ? ".reject" : ".approve");
    if (!button) return null;
    const rect = button.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, title: box.querySelector("h3").textContent };
  };
  window.__klWalletPopupClick = (which) => {
    const box = shadow?.getElementById("kl-wallet-popup");
    box?.querySelector(which === "reject" ? ".reject" : ".approve")?.click();
  };

  const rpcError = (code, message) => Object.assign(new Error(message), { code });
  const short = (value) => (typeof value === "string" && value.length > 14 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value);

  /* ---------- EIP-1193 provider ---------- */
  const listeners = new Map();
  const emit = (event, value) => (listeners.get(event) ?? []).forEach((fn) => fn(value));
  let chainId = config.defaultChainId;
  let connected = false;
  const hex = (n) => `0x${n.toString(16)}`;

  function fromHexUtf8(value) {
    if (typeof value !== "string" || !value.startsWith("0x")) return String(value);
    try {
      const bytes = new Uint8Array(value.slice(2).match(/../g)?.map((b) => parseInt(b, 16)) ?? []);
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return value;
    }
  }

  async function connect() {
    if (!connected && (await bridge({ kind: "permission", get: "evm" }))) connected = true;
    if (!connected) {
      const ok = await popup("Connect to this site?", [
        ["Site", location.host],
        ["Account", short(config.evmAddress)],
        ["Network", CHAIN_NAMES[chainId] ?? chainId],
      ], "Throwaway test key. Signs only against local fork RPCs.");
      if (!ok) throw rpcError(4001, "User rejected the request.");
      connected = true;
      await bridge({ kind: "permission", set: "evm", value: true });
      emit("connect", { chainId: hex(chainId) });
      emit("accountsChanged", [config.evmAddress]);
    }
    return [config.evmAddress];
  }

  async function request({ method, params = [] }) {
    switch (method) {
      case "eth_requestAccounts":
        return connect();
      case "eth_accounts":
        if (!connected && (await bridge({ kind: "permission", get: "evm" }))) connected = true;
        return connected ? [config.evmAddress] : [];
      case "eth_chainId":
        return hex(chainId);
      case "net_version":
        return String(chainId);
      case "wallet_requestPermissions":
        await connect();
        return [{ parentCapability: "eth_accounts" }];
      case "wallet_getPermissions":
        return connected ? [{ parentCapability: "eth_accounts" }] : [];
      case "wallet_revokePermissions":
        connected = false;
        await bridge({ kind: "permission", set: "evm", value: false });
        emit("accountsChanged", []);
        return null;
      case "wallet_switchEthereumChain": {
        const target = parseInt(params[0]?.chainId, 16);
        if (!config.forkChains.includes(target)) throw rpcError(4902, `Chain ${target} is not available in the test wallet (no local fork).`);
        if (target !== chainId) {
          const ok = await popup("Switch network?", [
            ["From", CHAIN_NAMES[chainId] ?? chainId],
            ["To", CHAIN_NAMES[target] ?? target],
          ]);
          if (!ok) throw rpcError(4001, "User rejected the request.");
          chainId = target;
          emit("chainChanged", hex(chainId));
        }
        return null;
      }
      case "wallet_addEthereumChain": {
        const target = parseInt(params[0]?.chainId, 16);
        if (!config.forkChains.includes(target)) throw rpcError(4902, `Chain ${target} has no local fork.`);
        return null;
      }
      case "wallet_getCapabilities":
      case "wallet_sendCalls":
      case "wallet_getCallsStatus":
      case "wallet_showCallsStatus":
      case "eth_sign":
        throw rpcError(4200, `${method} is not supported by the test wallet.`);
      case "personal_sign": {
        const ok = await popup("Signature request", [
          ["Network", CHAIN_NAMES[chainId] ?? chainId],
          ["Message", fromHexUtf8(params[0]).slice(0, 400)],
        ]);
        if (!ok) throw rpcError(4001, "User rejected the request.");
        return bridge({ kind: "personal_sign", message: params[0], address: params[1] });
      }
      case "eth_signTypedData_v4":
      case "eth_signTypedData": {
        const typed = typeof params[1] === "string" ? JSON.parse(params[1]) : params[1];
        const ok = await popup("Sign typed data", [
          ["Network", CHAIN_NAMES[chainId] ?? chainId],
          ["Domain", `${typed?.domain?.name ?? "?"} (chain ${typed?.domain?.chainId ?? "?"})`],
          ["Contract", short(typed?.domain?.verifyingContract ?? "-")],
          ["Type", typed?.primaryType ?? "?"],
          ["Message", JSON.stringify(typed?.message ?? {}).slice(0, 220)],
        ]);
        if (!ok) throw rpcError(4001, "User rejected the request.");
        return bridge({ kind: "typed", chainId, typed });
      }
      case "eth_sendTransaction": {
        const tx = params[0] ?? {};
        const ok = await popup("Confirm transaction", [
          ["Network", CHAIN_NAMES[chainId] ?? chainId],
          ["To", short(tx.to ?? "(contract creation)")],
          ["Value", tx.value ? `${Number(BigInt(tx.value)) / 1e18} native` : "0"],
          ["Call", tx.data && tx.data !== "0x" ? `${tx.data.slice(0, 10)} (${(tx.data.length - 2) / 2} bytes)` : "plain transfer"],
        ], "Sent to the local fork RPC only.");
        if (!ok) throw rpcError(4001, "User rejected the request.");
        return bridge({ kind: "send", chainId, tx });
      }
      default:
        if (/^(eth_|net_|web3_)/.test(method)) return bridge({ kind: "rpc", chainId, method, params });
        throw rpcError(4200, `${method} is not supported by the test wallet.`);
    }
  }

  const provider = {
    isKletiaTestWallet: true,
    request,
    on(event, fn) {
      listeners.set(event, [...(listeners.get(event) ?? []), fn]);
      return provider;
    },
    removeListener(event, fn) {
      listeners.set(event, (listeners.get(event) ?? []).filter((entry) => entry !== fn));
      return provider;
    },
  };
  provider.off = provider.removeListener;

  const info = Object.freeze({ uuid: config.uuid, name: NAME, icon: ICON, rdns: "xyz.kletia.testwallet" });
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();

  /* ---------- Wallet Standard (Solana) ---------- */
  if (config.solana) {
    const solListeners = { change: [] };
    const publicKey = new Uint8Array(config.solana.publicKey);
    const account = Object.freeze({
      address: config.solana.address,
      publicKey,
      chains: ["solana:mainnet"],
      features: ["solana:signTransaction", "solana:signMessage"],
    });
    const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
    const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
    const wallet = {
      version: "1.0.0",
      name: NAME,
      icon: ICON,
      chains: ["solana:mainnet"],
      accounts: [],
      features: {
        "standard:connect": {
          version: "1.0.0",
          async connect(input) {
            if (!wallet.accounts.length && (await bridge({ kind: "permission", get: "solana" }))) wallet.accounts = [account];
            if (!wallet.accounts.length) {
              if (input?.silent) return { accounts: [] };
              const ok = await popup("Connect Solana account?", [
                ["Site", location.host],
                ["Account", short(account.address)],
                ["Network", "Solana (local surfpool fork)"],
              ], "Throwaway test key. Signs only for the local fork.");
              if (!ok) throw rpcError(4001, "User rejected the request.");
              wallet.accounts = [account];
              await bridge({ kind: "permission", set: "solana", value: true });
              solListeners.change.forEach((fn) => fn({ accounts: wallet.accounts }));
            }
            return { accounts: wallet.accounts };
          },
        },
        "standard:disconnect": {
          version: "1.0.0",
          async disconnect() {
            wallet.accounts = [];
            await bridge({ kind: "permission", set: "solana", value: false });
            solListeners.change.forEach((fn) => fn({ accounts: [] }));
          },
        },
        "standard:events": {
          version: "1.0.0",
          on(event, fn) {
            (solListeners[event] ??= []).push(fn);
            return () => {
              solListeners[event] = solListeners[event].filter((entry) => entry !== fn);
            };
          },
        },
        "solana:signTransaction": {
          version: "1.0.0",
          supportedTransactionVersions: [0],
          async signTransaction(...inputs) {
            const outputs = [];
            for (const input of inputs) {
              const ok = await popup("Sign Solana transaction", [
                ["Network", "Solana (local fork)"],
                ["Account", short(account.address)],
                ["Size", `${input.transaction.length} bytes`],
              ], "The app broadcasts it to the local fork RPC.");
              if (!ok) throw rpcError(4001, "User rejected the request.");
              const signed = await bridge({ kind: "sol_sign_tx", transaction: b64(input.transaction) });
              outputs.push({ signedTransaction: unb64(signed) });
            }
            return outputs;
          },
        },
        "solana:signMessage": {
          version: "1.0.0",
          async signMessage(...inputs) {
            const outputs = [];
            for (const input of inputs) {
              let text;
              try {
                text = new TextDecoder("utf-8", { fatal: true }).decode(input.message);
              } catch {
                text = `${input.message.length} bytes`;
              }
              const ok = await popup("Sign message (Solana)", [["Message", text.slice(0, 400)]]);
              if (!ok) throw rpcError(4001, "User rejected the request.");
              const signature = await bridge({ kind: "sol_sign_message", message: b64(input.message) });
              outputs.push({ signedMessage: input.message, signature: unb64(signature) });
            }
            return outputs;
          },
        },
      },
    };
    const register = ({ register: add }) => add(wallet);
    try {
      window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: register }));
    } catch (error) {
      console.error("test wallet registration failed", error);
    }
    window.addEventListener("wallet-standard:app-ready", (event) => register(event.detail));
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", installCursor);
  else installCursor();
})(__KL_WALLET_CONFIG__);
