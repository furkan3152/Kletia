/**
 * The chassis rail: the KLETIA nameplate, the rotary mode dial over the
 * desk's sections (Desk, Trade, Portfolio, Automate; Tasks and More as keys under it), the binder
 * stack of the last three settled cards, the status LCD, the wallet cartridge and the sound and
 * night switches. From 1024 px; phones get the mini plate bar and the mode bar instead.
 */
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useEffect, useRef } from "react";

import { Dial, Eng, Icon, keyClass, Led, Nameplate, StatusDisplay, Thumb, Toggle, useSoundEnabled } from "../../../kit";
import { riffle } from "../../../kit/motion";
import { playSound } from "../../../kit/sound";
import type { SiteTheme } from "../../../site/theme";
import { useSolanaWallet } from "../../../../shared/wallet/solana/solanaWalletContext";
import { shortenAddress } from "../../../../shared/wallet/types";
import { useWallets } from "../../../../shared/wallet/useWallets";
import { DESK_COPY } from "../../content/copy";
import type { DeskSection } from "../../state/deskNav";
import { DESK_MORE_COPY } from "../deskCopy";
import type { BinderCard, LcdRow } from "./machineModel";

const copy = DESK_MORE_COPY.machine;
const sections = DESK_COPY.header.sections;

const DIAL_SECTIONS = ["desk", "trade", "portfolio", "automate"] as const;
type DialSection = (typeof DIAL_SECTIONS)[number];

export interface MachineRailProps {
  readonly section: DeskSection;
  readonly onSection: (section: DeskSection) => void;
  readonly taskCount: number;
  readonly binder: readonly BinderCard[];
  readonly binderCount: number;
  readonly onOpenBinder: () => void;
  readonly lcd: readonly LcdRow[];
  readonly theme: SiteTheme;
  readonly onToggleTheme: () => void;
  /** First desk open of the session: the nameplate sweeps and the dial spins in. */
  readonly booting: boolean;
}

export function MachineRail({ section, onSection, taskCount, binder, binderCount, onOpenBinder, lcd, theme, onToggleTheme, booting }: MachineRailProps) {
  const [sound, setSound] = useSoundEnabled();
  const dialValue: DialSection | null = (DIAL_SECTIONS as readonly string[]).includes(section) ? (section as DialSection) : null;
  return (
    <>
      <Nameplate model={copy.model} serial={serialLine()} label={copy.homeLabel} sweep={booting} />
      <div className="kd-mode" data-boot-part="">
        <Eng as="span">{copy.mode}</Eng>
        <Dial
          label={copy.mode}
          options={DIAL_SECTIONS.map((id) => ({ id, label: sections[id] }))}
          value={dialValue}
          onChange={(next) => {
            playSound("swap");
            onSection(next);
          }}
          boot={booting}
        />
        <div className="kd-mode-keys">
          <button type="button" className={keyClass({ tone: "flat", size: "sm" })} aria-current={section === "tasks" ? "page" : undefined} onClick={() => onSection("tasks")}>
            {copy.tasksKey(taskCount)}
          </button>
          <button type="button" className={keyClass({ tone: "flat", size: "sm" })} aria-current={section === "more" ? "page" : undefined} onClick={() => onSection("more")}>
            {copy.more}
          </button>
        </div>
      </div>
      <BinderStack cards={binder} count={binderCount} onOpen={onOpenBinder} />
      <div data-boot-part="">
        <StatusDisplay rows={lcd} label={copy.lcd} />
      </div>
      <div className="kd-rail-foot" data-boot-part="">
        <WalletCartridge />
        <div className="kd-switches">
          <Toggle checked={sound} onChange={setSound} label={copy.sound}>
            <Icon name={sound ? "snd" : "mute"} />
          </Toggle>
          <Toggle checked={theme === "dark"} onChange={() => onToggleTheme()} label={copy.night}>
            <Icon name="moon" />
          </Toggle>
        </div>
      </div>
    </>
  );
}

/** "SN 7A3F": the deployment's build stamp when there is one, else the model's own line. */
function serialLine(): string {
  const build = (import.meta.env.VITE_BUILD_SHA as string | undefined)?.slice(0, 4).toUpperCase();
  return build ? `SN ${build}` : "V1";
}

export function BinderStack({ cards, count, onOpen }: { readonly cards: readonly BinderCard[]; readonly count: number; readonly onOpen: () => void }) {
  const stack = useRef<HTMLSpanElement>(null);
  const top = cards[cards.length - 1]?.id ?? null;
  const previousTop = useRef(top);
  // A newly settled card riffles onto the stack.
  useEffect(() => {
    if (top && previousTop.current !== top && previousTop.current !== undefined) {
      const thumbs = [...(stack.current?.querySelectorAll(".k-thumb") ?? [])];
      riffle(thumbs[thumbs.length - 1], thumbs.slice(0, -1));
      playSound("riffle");
    }
    previousTop.current = top;
  }, [top]);
  const last = cards[cards.length - 1];
  return (
    <button type="button" className="kd-binder" data-boot-part="" aria-label={copy.binderOpen(count)} onClick={onOpen}>
      <span className="kd-binder-h">
        <Eng as="span">{copy.binder}</Eng>
        <b aria-hidden="true">{count}</b>
      </span>
      <span ref={stack} className="kd-binder-cards" aria-hidden="true">
        {cards.length === 0 ? <Thumb kind={copy.binder} serial="0000" title={copy.binderEmpty} className="k-thumb--sleeve" /> : cards.map((card) => <Thumb key={card.id} kind={card.kind} serial={card.serial} title={card.title} sub={card.sub} />)}
      </span>
      <span className="kd-binder-f" aria-hidden="true">
        {last ? copy.binderLast(last.title) : copy.binderEmpty}
      </span>
    </button>
  );
}

/** The wallet cartridge: both wallets seated in one slot, each row opening its own connect flow. */
export function WalletCartridge() {
  const { evm, solana } = useWallets();
  const { openPicker, status } = useSolanaWallet();
  const wallets = DESK_COPY.wallets;
  return (
    <div className="kd-wslot" role="group" aria-label={copy.wallet}>
      <span className="kd-ws-mouth" aria-hidden="true" />
      <div className="kd-ws-cart">
        <ConnectButton.Custom>
          {({ account, openAccountModal, openConnectModal, mounted, authenticationStatus }) => {
            const ready = mounted && authenticationStatus !== "loading";
            const connected = Boolean(ready && account && evm);
            const short = evm ? shortenAddress(evm.address) : null;
            return (
              <button
                type="button"
                className="kd-ws-row"
                data-wallet="evm"
                disabled={!ready}
                onClick={connected ? openAccountModal : openConnectModal}
                aria-label={connected && evm && short ? wallets.evmConnected(evm.walletName, short) : wallets.connectEvm}
              >
                <span className="kd-ws-av" data-off={connected ? undefined : ""} aria-hidden="true" />
                <span style={{ minWidth: 0 }}>
                  <b>{connected && short ? short : DESK_MORE_COPY.wallets.connectEvmShort}</b>
                  <small>{connected && evm ? `EVM · ${evm.walletName}` : "EVM"}</small>
                </span>
                <Led tone={connected ? "on" : "off"} />
              </button>
            );
          }}
        </ConnectButton.Custom>
        <button
          type="button"
          className="kd-ws-row"
          data-wallet="solana"
          onClick={openPicker}
          aria-haspopup="dialog"
          aria-label={solana ? wallets.solanaConnected(solana.walletName, shortenAddress(solana.address)) : wallets.connectSolana}
        >
          <span className="kd-ws-av" data-off={solana ? undefined : ""} aria-hidden="true" />
          <span style={{ minWidth: 0 }}>
            <b>{solana ? shortenAddress(solana.address) : DESK_MORE_COPY.wallets.connectSolanaShort}</b>
            <small>{solana ? `Solana · ${solana.walletName}` : status === "connecting" ? "Solana · connecting" : "Solana"}</small>
          </span>
          <Led tone={solana ? "on" : "off"} />
        </button>
      </div>
    </div>
  );
}
