/**
 * What goes with a dry-run card (Card machine):
 * every turn plans without storing anything (`?clarify=true&dryRun=true&preview=true`), so the
 * card's key never signs from here. `PreviewKeys` are the card's keys: "Review and sign" stores the
 * plan (the commit turn) and the review takes over; without the wallets the plan needs, the exact
 * connect keys (the task plans again with the user's accounts once they connect). Under the card
 * (`PreviewTaskBody`): one line saying what this card is, "Kletia assumed" chips, the itinerary
 * and the fare line by line.
 */
import "../../site/art/journey.css";

import type { ReactNode } from "react";
import type { ClarifyAssumption, IntentGraph, IntentPreview } from "@kletia/core";
import { AssumptionChips } from "@kletia/widget";

import { Icon, Key } from "../../kit";
import { FareTable } from "../../site/intent/FareTable";
import { DESK_COPY } from "../content/copy";
import { useDeskActions } from "../shell/deskContext";
import { SystemNote } from "./Conversation";
import { isDemoAccount } from "./demoAccounts";
import type { WalletNamespace } from "./taskModel";

const copy = DESK_COPY.preview;

const DRY_RUN = "A dry run with your accounts: nothing is stored or signed yet. Review it to store the plan, then confirm before your wallet signs.";

export interface PreviewKeysProps {
  readonly missing: readonly WalletNamespace[];
  readonly replanning: boolean;
  /** Stores the plan with the user's accounts (the commit turn); absent while wallets are missing. */
  readonly onReview?: () => void;
  readonly reviewing?: boolean;
  /** Why "Review and sign" cannot start now (another task is signing). */
  readonly reviewBlocked?: string | null;
}

/** The dry card's keys: Review and sign (one lime key), or the wallets to connect first. */
export function PreviewKeys({ missing, replanning, onReview, reviewing = false, reviewBlocked = null }: PreviewKeysProps) {
  const { openWallet } = useDeskActions();
  if (missing.length === 0 && onReview) {
    return (
      <>
        {reviewBlocked ? <span className="kd-card-hint">{reviewBlocked}</span> : null}
        <Key tone="lime" size="sm" onClick={onReview} disabled={replanning || reviewing || Boolean(reviewBlocked)} aria-busy={reviewing || undefined}>
          <Icon name="lock" />
          {reviewing ? "Storing the plan…" : "Review and sign"}
        </Key>
      </>
    );
  }
  return (
    <>
      {missing.map((namespace) => (
        <Key key={namespace} tone="lime" size="sm" onClick={() => openWallet(namespace)} disabled={replanning}>
          <Icon name="wallet" />
          {namespace === "eip155" ? copy.connectEvm : copy.connectSolana}
        </Key>
      ))}
    </>
  );
}

export interface PreviewTaskBodyProps {
  readonly intent: IntentGraph;
  readonly preview: IntentPreview | null;
  readonly missing: readonly WalletNamespace[];
  readonly replanning: boolean;
  /** The journey slot (review phase). */
  readonly journey: ReactNode;
  /** "Kletia assumed" chips of the turn that planned it; another value plans the task again. */
  readonly assumptions?: readonly ClarifyAssumption[];
  readonly onAssumption?: (id: string, option: string) => void;
  readonly reviewing?: boolean;
}

export function PreviewTaskBody({ intent, preview, missing, replanning, journey, assumptions = [], onAssumption, reviewing = false }: PreviewTaskBodyProps) {
  const ready = missing.length === 0;
  return (
    <>
      <SystemNote icon={ready ? "shield" : "wallet"} role="status">
        {replanning ? copy.replanning : ready ? DRY_RUN : `${copy.notice} ${copy.connectHint}`}
      </SystemNote>
      {assumptions.length > 0 && onAssumption ? (
        <div className="kla-qcard kd-assume">
          <AssumptionChips assumptions={assumptions} onChange={onAssumption} disabled={replanning || reviewing} />
        </div>
      ) : null}
      {journey}
      {preview ? (
        <details className="kd-memory kd-fare">
          <summary>The fare, line by line</summary>
          <FareTable preview={preview} intent={intent} isDemoAccount={isDemoAccount} />
        </details>
      ) : null}
    </>
  );
}
