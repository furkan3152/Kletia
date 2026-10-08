import React from "react";
import {
  CHAINS,
  formatAccountId,
  isSolanaAddress,
  sameAccount,
  toBaseUnits,
  type SolanaTransactionRequest,
} from "@kletia/core";
import { CircleCheck, Send, ShieldCheck, TriangleAlert } from "lucide-react";

import { useKletiaEvent } from "../../../shared/sync/bus";
import { shortenAddress } from "../../../shared/wallet/types";
import {
  parsePortfolio,
  prepareTransfer,
  solanaPaths,
  type SolanaNetworkKey,
  type SolanaPortfolio,
  type SolanaPreparedTransfer,
} from "../api";
import { formatTokenAmount, validateAmountInput } from "../format";
import { exceedsBalance, maxSpendable } from "../hooks/useSwapFlow";
import { useSolanaExecution } from "../hooks/useSolanaExecution";
import { useSolanaResource } from "../hooks/useSolanaResource";
import { canonicalTokens } from "../tokens";
import { ui } from "../styles";
import { ConnectSolanaCta, DetailRow, ExecutionPanel, PanelHeader } from "./SolanaUi";

interface SolanaSendProps {
  owner: string | null;
  /** Mainnet portfolio shared by the workspace. */
  portfolio: SolanaPortfolio | null;
}

interface TransferDetails {
  readonly network: SolanaNetworkKey;
  readonly recipient: string;
  readonly prepared: SolanaPreparedTransfer;
}

const SIMULATION_UNAVAILABLE = "Simulation unavailable";

function TransferReview({ details }: { details: TransferDetails }) {
  const { prepared, recipient, network } = details;
  const simulation = prepared.prepared.simulation;
  return (
    <div className="flex flex-col gap-3">
      <dl className="flex flex-col">
        <DetailRow label="Network">{CHAINS[network].name}</DetailRow>
        <DetailRow label="Amount">
          {formatTokenAmount(prepared.formatted)} {prepared.token.symbol}
        </DetailRow>
        <DetailRow label="Recipient">
          <span className="break-all font-mono text-xs">{recipient}</span>
        </DetailRow>
        <DetailRow label="Valid until block">{prepared.prepared.lastValidBlockHeight}</DetailRow>
      </dl>
      {simulation.ok ? (
        <p className="flex items-center gap-2 border-[3px] border-[#1A1A1A] bg-[#DCFCE7] p-3 text-sm font-black text-[#14532D] dark:border-[#4B5563] dark:bg-[#0F2A1D] dark:text-[#BBF7D0]">
          <CircleCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
          Simulation passed
          {simulation.unitsConsumed !== null ? ` · ${simulation.unitsConsumed.toLocaleString("en-US")} compute units` : ""}
        </p>
      ) : simulation.error === SIMULATION_UNAVAILABLE ? (
        <p className={`${ui.warningBox} flex items-start gap-2`}>
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          The RPC could not simulate this transfer. Your wallet will still simulate it before you approve.
        </p>
      ) : null}
      {prepared.token.symbol !== "SOL" ? (
        <p className="text-xs font-bold text-gray-600 dark:text-slate-300">
          If the recipient has no {prepared.token.symbol} account yet, this transaction creates it and
          you pay its one-time rent deposit.
        </p>
      ) : null}
    </div>
  );
}

export function SolanaSend({ owner, portfolio }: SolanaSendProps) {
  const [network, setNetwork] = React.useState<SolanaNetworkKey>("solana");
  const [symbol, setSymbol] = React.useState("SOL");
  const [amount, setAmount] = React.useState("");
  const [recipient, setRecipient] = React.useState("");
  const [touched, setTouched] = React.useState(false);
  const ids = {
    asset: React.useId(),
    amount: React.useId(),
    amountHint: React.useId(),
    recipient: React.useId(),
    recipientHint: React.useId(),
    network: React.useId(),
  };
  const tokens = React.useMemo(() => canonicalTokens(network), [network]);
  const token = tokens.find((candidate) => candidate.symbol === symbol) ?? tokens[0];
  const devnetPortfolio = useSolanaResource(
    owner && network === "solana-devnet" ? solanaPaths.portfolio(owner, "solana-devnet") : null,
    parsePortfolio,
  );
  const activePortfolio = network === "solana" ? portfolio : devnetPortfolio.data;
  const refreshDevnet = devnetPortfolio.refresh;
  useKletiaEvent("portfolio.invalidated", (event) => {
    if (
      event.network === "solana-devnet" &&
      owner &&
      sameAccount(event.account, formatAccountId("solana-devnet", owner))
    ) {
      refreshDevnet();
    }
  });
  const execution = useSolanaExecution<TransferDetails>();
  const locked =
    execution.phase !== "idle" && execution.phase !== "confirmed" && execution.phase !== "failed";

  const amountError = amount.trim() ? validateAmountInput(amount, token.decimals) : null;
  const overBalance =
    amount.trim() !== "" && !amountError && exceedsBalance(activePortfolio, token, amount);
  const trimmedRecipient = recipient.trim();
  const recipientError = !trimmedRecipient
    ? null
    : !isSolanaAddress(trimmedRecipient)
      ? "Enter a valid Solana address (base58, 32 bytes)."
      : trimmedRecipient === owner
        ? "Recipient is the connected account."
        : null;
  const max = maxSpendable(activePortfolio, token);
  const ready =
    Boolean(owner) &&
    amount.trim() !== "" &&
    !amountError &&
    !overBalance &&
    trimmedRecipient !== "" &&
    !recipientError &&
    !locked;

  const review = () => {
    setTouched(true);
    if (!ready || !owner) return;
    const sendAmount = amount.trim();
    const target = trimmedRecipient;
    const selected = token;
    const selectedNetwork = network;
    void execution.prepare(async (signal) => {
      const prepared = await prepareTransfer(
        { network: selectedNetwork, owner, recipient: target, asset: selected.symbol, amount: sendAmount },
        signal,
      );
      if (
        prepared.token.mint !== selected.mint ||
        prepared.amount !== toBaseUnits(sendAmount, selected.decimals)
      ) {
        throw new Error("The prepared transfer does not match the requested asset and amount.");
      }
      const title = `Send ${formatTokenAmount(prepared.formatted)} ${prepared.token.symbol} to ${shortenAddress(target)}`;
      const request: SolanaTransactionRequest = {
        vm: "svm",
        network: selectedNetwork,
        feePayer: owner,
        transaction: prepared.prepared.transaction,
        encoding: "base64",
        lastValidBlockHeight: prepared.prepared.lastValidBlockHeight,
        description: title,
      };
      const simulation = prepared.prepared.simulation;
      return {
        request,
        title,
        details: { network: selectedNetwork, recipient: target, prepared },
        blockedReason:
          !simulation.ok && simulation.error !== SIMULATION_UNAVAILABLE
            ? `Simulation failed, so Kletia will not ask you to sign: ${simulation.error ?? "unknown error"}.`
            : null,
      };
    });
  };

  return (
    <div className="flex flex-col gap-5">
      <PanelHeader
        icon={Send}
        title="Send"
        description="SOL, SPL and Token-2022 transfers. Kletia re-checks the mint on-chain, simulates the transfer and shows the result before your wallet signs."
      />
      {!owner ? <ConnectSolanaCta /> : null}

      <form
        noValidate
        className={`${ui.card} flex flex-col gap-4`}
        onSubmit={(event) => {
          event.preventDefault();
          review();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <span id={ids.network} className={ui.label}>
            Network
          </span>
          <div role="group" aria-labelledby={ids.network} className="flex flex-wrap gap-2">
            {(["solana", "solana-devnet"] as const).map((key) => (
              <button
                key={key}
                type="button"
                disabled={locked}
                aria-pressed={network === key}
                onClick={() => {
                  setNetwork(key);
                  setSymbol("SOL");
                  execution.reset();
                }}
                className={ui.chip(network === key)}
              >
                {key === "solana" ? "Mainnet" : "Devnet"}
              </button>
            ))}
          </div>
          {network === "solana-devnet" ? (
            <p className="text-xs font-bold text-gray-600 dark:text-slate-300">
              Devnet tokens have no value. Make sure your wallet is also set to devnet.
            </p>
          ) : null}
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.asset} className={ui.label}>
              Asset
            </label>
            <select
              id={ids.asset}
              value={token.symbol}
              disabled={locked}
              onChange={(event) => {
                setSymbol(event.target.value);
                execution.reset();
              }}
              className={ui.input}
            >
              {tokens.map((option) => (
                <option key={option.mint} value={option.symbol}>
                  {option.symbol} · {option.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor={ids.amount} className={ui.label}>
                Amount ({token.symbol})
              </label>
              {max !== null ? (
                <button
                  type="button"
                  disabled={locked}
                  onClick={() => setAmount(max)}
                  className="text-[11px] font-black uppercase text-[#9945FF] underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#9945FF] disabled:opacity-50 dark:text-[#C4A1FF]"
                >
                  Max {formatTokenAmount(max)}
                </button>
              ) : null}
            </div>
            <input
              id={ids.amount}
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.0"
              value={amount}
              disabled={locked}
              onChange={(event) => setAmount(event.target.value.replace(",", "."))}
              aria-invalid={Boolean(amountError) || overBalance}
              aria-describedby={ids.amountHint}
              className={ui.input}
            />
            <p id={ids.amountHint} className="text-xs font-bold text-gray-600 dark:text-slate-300" aria-live="polite">
              {amountError ?? (overBalance ? `Amount exceeds your ${token.symbol} balance.` : " ")}
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.recipient} className={ui.label}>
            Recipient address
          </label>
          <input
            id={ids.recipient}
            autoComplete="off"
            spellCheck={false}
            placeholder="Solana address"
            value={recipient}
            disabled={locked}
            onChange={(event) => setRecipient(event.target.value)}
            onBlur={() => setTouched(true)}
            aria-invalid={Boolean(recipientError) || (touched && !trimmedRecipient)}
            aria-describedby={ids.recipientHint}
            className={`${ui.input} font-mono text-sm`}
          />
          <p id={ids.recipientHint} className="text-xs font-bold text-gray-600 dark:text-slate-300" aria-live="polite">
            {recipientError ??
              (touched && !trimmedRecipient
                ? "Enter the recipient's Solana address."
                : "Transfers are irreversible. Double-check the address.")}
          </p>
        </div>

        <button type="submit" disabled={!ready} className={`${ui.primaryButton} self-start`}>
          <ShieldCheck className="h-4 w-4" aria-hidden="true" />
          Review transfer
        </button>
      </form>

      <ExecutionPanel<TransferDetails> execution={execution} confirmLabel="Sign transfer in wallet">
        {execution.prepared ? <TransferReview details={execution.prepared.details} /> : null}
      </ExecutionPanel>
    </div>
  );
}
