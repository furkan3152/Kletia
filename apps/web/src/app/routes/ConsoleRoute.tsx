import DeskApp from "../console/DeskApp";
import { WalletProviders } from "../providers";

/** The desk at /app (and its views): wallet providers plus the one composer for all nine networks. */
export default function ConsoleRoute() {
  return (
    <WalletProviders>
      <DeskApp />
    </WalletProviders>
  );
}
