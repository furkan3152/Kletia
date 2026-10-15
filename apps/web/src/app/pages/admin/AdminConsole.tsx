/**
 * The wallet half of /admin: wagmi + RainbowKit (EVM) and Wallet Standard
 * (Solana) around the panel. The only module through which the admin route
 * reaches wallet code (scripts/check-route-chunks.mjs, WALLET_PANELS.admin).
 */
import "../../site/art/base.css";

import { WalletProviders } from "../../providers";
import { AdminApp } from "./AdminApp";
import type { AdminClient } from "./api/adminClient";
import type { AdminSessionView } from "./model/types";

export interface AdminConsoleProps {
  readonly client: AdminClient;
  readonly initialSession: AdminSessionView | null;
  /** Re-runs the wallet-free gate (admin turned off, store gone, API unreachable). */
  readonly onGate: () => void;
}

export default function AdminConsole(props: AdminConsoleProps) {
  return (
    <WalletProviders>
      <AdminApp {...props} />
    </WalletProviders>
  );
}
