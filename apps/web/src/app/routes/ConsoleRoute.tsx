import App from "../App";
import { WalletProviders } from "../providers";

/** The intent console: wallet providers plus the network workspaces. */
export default function ConsoleRoute() {
  return (
    <WalletProviders>
      <App />
    </WalletProviders>
  );
}
