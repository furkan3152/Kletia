import "../../site/art/base.css";
import "./link.css";

import { CHAINS, explorerAddressUrl, isNetworkKey, type LinkView } from "@kletia/core";
import { useId } from "react";

import { LineBullet } from "../../site/art/LineBullet";
import { lineFor } from "../../site/art/tokens";
import { cx, LABEL } from "../../site/ui/styles";
import { httpsOnly } from "./linkModel";

/*
 * "Fixed by the publisher": every pinned recipient (name, full address,
 * network, explorer link) and every custom contract, always visible before
 * anything is signed. Unverified publishers and unverified contract sources
 * need an explicit acknowledgement before the visitor can continue.
 */

export interface FixedByPublisherProps {
  readonly view: LinkView;
  readonly needsAcknowledgement: boolean;
  readonly acknowledged: boolean;
  readonly onAcknowledge: (value: boolean) => void;
  readonly disabled?: boolean;
}

function explorerFor(network: string, address: string): string | null {
  return isNetworkKey(network) ? httpsOnly(explorerAddressUrl(network, address)) : null;
}

function NetworkTag({ network }: { readonly network: string }) {
  const line = lineFor(network);
  return (
    <span className="inline-flex items-center gap-2 text-sm font-bold">
      {line ? <LineBullet line={line} decorative /> : null}
      {isNetworkKey(network) ? CHAINS[network].name : network}
    </span>
  );
}

export function FixedByPublisher({ view, needsAcknowledgement, acknowledged, onAcknowledge, disabled = false }: FixedByPublisherProps) {
  const checkboxId = useId();
  const contracts = view.destination.actions.filter((action) => action.contract);
  const nothingFixed = view.fixed.recipients.length === 0 && contracts.length === 0 && view.fixed.contracts.length === 0;
  return (
    <div className="kl-link-fixed">
      <div className="flex flex-col gap-5 p-4 sm:p-5">
        <p className="text-sm font-semibold leading-relaxed">
          {nothingFixed
            ? "This link pays nobody else and calls no custom contract: every step sends money to your own accounts."
            : "The publisher fixed where the money goes. Kletia checks every plan against this list and refuses anything else."}
        </p>

        {view.fixed.recipients.length > 0 ? (
          <div>
            <p className={LABEL}>Pays</p>
            <ul className="mt-2 flex flex-col gap-3">
              {view.fixed.recipients.map((recipient) => {
                const href = explorerFor(recipient.network, recipient.address);
                return (
                  <li key={`${recipient.network}:${recipient.address}`} className="flex flex-col gap-1 border-l-[3px] border-[#1A1A1A] pl-3">
                    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      {recipient.name ? <span className="font-display text-lg font-bold">{recipient.name}</span> : null}
                      <NetworkTag network={recipient.network} />
                    </span>
                    <span className="kl-link-fixed__addr">{recipient.address}</span>
                    {recipient.name ? (
                      <span className="text-xs font-semibold text-[#45464B]">
                        The name was resolved and pinned when the link was published. If it ever points elsewhere, the link pauses itself.
                      </span>
                    ) : null}
                    {href ? (
                      <a className="kla-link self-start text-xs font-bold" href={href} target="_blank" rel="noopener noreferrer">
                        See this address on the explorer
                        <span className="kla-sr"> (opens in a new tab)</span>
                      </a>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}

        {contracts.length > 0 || view.fixed.contracts.length > 0 ? (
          <div>
            <p className={LABEL}>Calls a custom contract</p>
            <ul className="mt-2 flex flex-col gap-3">
              {(contracts.length > 0
                ? contracts.map((action) => ({
                    network: action.network as string,
                    address: action.contract!.address,
                    label: action.label,
                    integrator: action.contract!.integrator,
                    verified: action.contract!.domainVerified,
                    source: action.contract!.source ?? null,
                    revision: action.contract!.revision as number | null,
                  }))
                : view.fixed.contracts.map((contract) => ({ ...contract, integrator: null, verified: false, source: null, revision: null }))
              ).map((contract) => {
                const href = explorerFor(contract.network, contract.address);
                return (
                  <li key={`${contract.network}:${contract.address}`} className="flex flex-col gap-1 border-l-[3px] border-[#1A1A1A] pl-3">
                    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="font-display text-lg font-bold">{contract.label}</span>
                      <NetworkTag network={contract.network} />
                    </span>
                    <span className="kl-link-fixed__addr">{contract.address}</span>
                    <span className="text-xs font-semibold text-[#45464B]">
                      {contract.integrator ? `Registered by ${contract.integrator}` : "Registered by the publisher"}
                      {contract.revision !== null ? `, revision ${contract.revision}` : ""}
                      {contract.source ? `, source ${contract.source.replace(/_/gu, " ")}` : ""}
                      {contract.verified ? ", domain verified." : ", domain not verified."} Not audited by Kletia.
                    </span>
                    {href ? (
                      <a className="kla-link self-start text-xs font-bold" href={href} target="_blank" rel="noopener noreferrer">
                        See this contract on the explorer
                        <span className="kla-sr"> (opens in a new tab)</span>
                      </a>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}

        {needsAcknowledgement ? (
          <div className="flex items-start gap-3 border-[3px] border-[#1A1A1A] bg-[#FFF3B0] p-3">
            <input
              id={checkboxId}
              type="checkbox"
              className={cx("mt-1 h-5 w-5 shrink-0 accent-[#0052FF]")}
              checked={acknowledged}
              disabled={disabled}
              onChange={(event) => onAcknowledge(event.target.checked)}
            />
            <label htmlFor={checkboxId} className="text-sm font-semibold leading-relaxed">
              {view.publisher.domainVerified
                ? "I checked the custom contract above. Kletia did not audit it."
                : `I understand that ${view.publisher.domain ?? "this publisher's website"} has not verified this link, and I checked the recipients and contracts above myself.`}
            </label>
          </div>
        ) : null}
      </div>
    </div>
  );
}
