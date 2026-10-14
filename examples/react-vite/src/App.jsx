import { KletiaIntentWidget } from "@kletia/widget";
import { useMemo, useState } from "react";

import { ACTIONS, APPEARANCE, EXAMPLES, KLETIA_API_URL, NETWORKS } from "./config.js";
import { connectInjectedWallet, hasInjectedWallet, PREVIEW_ACCOUNTS } from "./wallet.js";

export function App() {
  // Keep client options stable: a new object would create a new client on every render.
  const clientOptions = useMemo(() => ({ baseUrl: KLETIA_API_URL }), []);
  const [wallet, setWallet] = useState(null);
  const [message, setMessage] = useState("");

  const connect = async () => {
    setMessage("");
    try {
      setWallet(await connectInjectedWallet(NETWORKS));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The wallet did not connect.");
    }
  };

  return (
    <main style={{ maxWidth: 520, margin: "40px auto", padding: "0 16px", color: "#1E1B4B" }}>
      <h1 style={{ fontSize: 24, margin: "0 0 8px" }}>Acme checkout</h1>
      <p style={{ margin: "0 0 16px" }}>
        {wallet
          ? "Your wallet plans and signs every step."
          : "Plans below are previews for demo accounts. Connect a wallet to plan with your own and sign."}
      </p>
      {wallet ? null : (
        <button type="button" onClick={() => void connect()} style={{ minHeight: 44, marginBottom: 16 }}>
          {hasInjectedWallet() ? "Connect wallet" : "Connect wallet (none found)"}
        </button>
      )}
      {message ? <p role="alert">{message}</p> : null}
      <KletiaIntentWidget
        // A new wallet starts a fresh widget, so nothing planned for the demo accounts can be signed.
        key={wallet ? wallet.accounts.join(",") : "preview"}
        clientOptions={clientOptions}
        accounts={wallet ? wallet.accounts : PREVIEW_ACCOUNTS}
        {...(wallet ? { signers: wallet.signers } : {})}
        appearance={APPEARANCE}
        networks={NETWORKS}
        actions={ACTIONS}
        sourceNetwork="auto"
        examples={EXAMPLES}
        metadata={{ orderId: "demo-42" }}
        onComplete={(intent) => console.info("Intent finished:", intent.id, intent.status)}
        onError={(error) => console.warn(error)}
      />
    </main>
  );
}
