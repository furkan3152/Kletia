/**
 * EVM and Solana wallets side by side: two pills of the same shape,
 * neutral ink, a green lamp when connected. Neither is "the workspace",
 * and there is no "Wrong network" state: platform steps switch the EVM
 * chain per step, and network-engine tasks show their own bar. The EVM
 * pill opens RainbowKit's account or connect modal, the Solana pill the
 * Wallet Standard picker. Accessible names contain the visible text.
 */
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { ChevronDown, LoaderCircle } from "lucide-react";

import { keyClass, Led } from "../../kit";
import { useSolanaWallet } from "../../../shared/wallet/solana/solanaWalletContext";
import { shortenAddress } from "../../../shared/wallet/types";
import { useWallets } from "../../../shared/wallet/useWallets";
import { DESK_COPY } from "../content/copy";
import { DESK_MORE_COPY } from "./deskCopy";

const copy = DESK_COPY.wallets;

/** Card machine keycaps: the wallet pills of the phone bar and anywhere outside the cartridge. */
const PILL = keyClass({ size: "sm" }, "min-w-11 max-w-[14rem]");

function Lamp() {
  return <Led tone="on" />;
}

function EvmPill() {
  const { evm } = useWallets();
  return (
    <ConnectButton.Custom>
      {({ account, openAccountModal, openConnectModal, mounted, authenticationStatus }) => {
        const ready = mounted && authenticationStatus !== "loading";
        const connected = ready && account && evm;
        if (!connected) {
          return (
            <button type="button" onClick={openConnectModal} aria-label={copy.connectEvm} className={PILL} disabled={!ready} data-wallet="evm">
              <span className="sm:hidden">{copy.compactEvm}</span>
              <span className="hidden whitespace-nowrap sm:inline">{DESK_MORE_COPY.wallets.connectEvmShort}</span>
            </button>
          );
        }
        const short = shortenAddress(evm.address);
        return (
          <button type="button" onClick={openAccountModal} aria-label={copy.evmConnected(evm.walletName, short)} className={PILL} data-wallet="evm">
            <span>{copy.evmLabel}</span>
            <Lamp />
            <span className="hidden min-w-0 truncate md:inline">
              {evm.walletName} · <span className="font-code">{short}</span>
            </span>
            <ChevronDown className="hidden h-3.5 w-3.5 shrink-0 md:block" aria-hidden="true" />
          </button>
        );
      }}
    </ConnectButton.Custom>
  );
}

function SolanaPill() {
  const { status, openPicker } = useSolanaWallet();
  const { solana } = useWallets();
  if (!solana) {
    return (
      <button type="button" onClick={openPicker} aria-haspopup="dialog" aria-label={copy.connectSolana} className={PILL} data-wallet="solana">
        {status === "connecting" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
        <span className="sm:hidden">{copy.compactSolana}</span>
        <span className="hidden whitespace-nowrap sm:inline">{DESK_MORE_COPY.wallets.connectSolanaShort}</span>
      </button>
    );
  }
  const short = shortenAddress(solana.address);
  return (
    <button type="button" onClick={openPicker} aria-haspopup="dialog" aria-label={copy.solanaConnected(solana.walletName, short)} className={PILL} data-wallet="solana">
      <span>{copy.compactSolana}</span>
      <Lamp />
      <span className="hidden min-w-0 truncate md:inline">
        {solana.walletName} · <span className="font-code">{short}</span>
      </span>
      <ChevronDown className="hidden h-3.5 w-3.5 shrink-0 md:block" aria-hidden="true" />
    </button>
  );
}

export function WalletBar() {
  return (
    <div role="group" aria-label={DESK_MORE_COPY.wallets.group} className="flex min-w-0 items-center gap-2">
      <EvmPill />
      <SolanaPill />
    </div>
  );
}
