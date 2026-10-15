import { StatusPill } from "../../../site/ui/StatusPill";
import { cx, LABEL, TEXT_MUTED } from "../../../site/ui/styles";
import type { AddressBook } from "../model/preview";
import type { ActorMode } from "../model/session";
import type { AdminContractState, AdminEvmNetwork } from "../model/types";
import { AddressText } from "./AddressText";

const KIND_LABEL: Readonly<Record<AdminContractState["ownerKind"], string>> = {
  eoa: "Plain wallet",
  safe: "Safe",
  contract: "Contract",
  none: "No owner",
};

const ACTOR_PILL: Readonly<Record<ActorMode, { tone: "success" | "info" | "warning" | "neutral"; label: string }>> = {
  direct: { tone: "success", label: "You own it" },
  "via-safe": { tone: "info", label: "Via Safe proposal" },
  "pending-owner": { tone: "warning", label: "You can accept ownership" },
  no: { tone: "neutral", label: "Owned by another wallet" },
};

/** Who owns a contract, what kind of owner it is and what the connected wallet can do about it. */
export function OwnerBadge({ state, actor, network, book }: { readonly state: AdminContractState; readonly actor: ActorMode; readonly network: AdminEvmNetwork; readonly book: AddressBook }) {
  const pill = ACTOR_PILL[actor];
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cx(LABEL, TEXT_MUTED)}>Owner</span>
        <span className={cx(LABEL, "border-2 border-current px-1.5")}>{KIND_LABEL[state.ownerKind]}</span>
        {state.ownerKind === "safe" && state.safe ? (
          <span className={cx("text-sm", TEXT_MUTED)}>
            {state.safe.threshold} of {state.safe.owners.length} owners, nonce {state.safe.nonce}
          </span>
        ) : null}
        <StatusPill tone={pill.tone}>{pill.label}</StatusPill>
      </div>
      {state.owner ? <AddressText address={state.owner} network={network} book={book} /> : null}
      {state.pendingOwner ? (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span className={cx(LABEL, TEXT_MUTED)}>Pending owner</span>
          <AddressText address={state.pendingOwner} network={network} book={book} />
        </p>
      ) : null}
    </div>
  );
}
