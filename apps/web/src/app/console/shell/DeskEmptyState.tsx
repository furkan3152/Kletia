/**
 * The empty desk: the question, a compact departure board of
 * network status (`GET /v1/health`), and "Try one" starters that
 * fill the composer without sending anything, filtered by what the
 * deployment offers and re-phrased from the departure.
 */
import { CHAINS, NETWORK_KEYS, type NetworkKey } from "@kletia/core";

import { DepartureBoard } from "../../site/art/DepartureBoard";
import { LineBullet } from "../../site/art/LineBullet";
import { boardStatus, formatBoardClock } from "../../site/art/boardFormat";
import { LINES } from "../../site/art/tokens";
import { DESK_COPY } from "../content/copy";
import { fillStarterAddress, STARTER_CAPABILITIES, startersFor, type NetworkActions } from "../content/starters";
import type { Departure, HealthReading } from "../state/deskModel";
import { useDeskActions } from "./deskContext";

const copy = DESK_COPY.empty;

export interface DeskEmptyStateProps {
  readonly departure: Departure;
  readonly actions: NetworkActions;
  readonly health: Readonly<Partial<Record<NetworkKey, HealthReading>>>;
  readonly healthAt: string | null;
  readonly onPick: (sentence: string) => void;
}

export function DeskEmptyState({ departure, actions, health, healthAt, onPick }: DeskEmptyStateProps) {
  const rows = NETWORK_KEYS.map((key) => ({
    line: LINES[key],
    latencyMs: health[key]?.latencyMs ?? null,
    status: boardStatus(health[key] ?? null, { loading: healthAt === null }),
  }));
  const starters = startersFor({ departure, actions, featuredOnly: true });
  // A test-yard `<address>` is the connected wallet's own address, or left for Kletia to ask: never inserted as is.
  const { accounts } = useDeskActions();
  const sentenceOf = (sentence: string) => fillStarterAddress(sentence, { evm: accounts.evm?.address ?? null, solana: accounts.solana?.address ?? null });
  const label = (capability: string) => STARTER_CAPABILITIES.find((entry) => entry.id === capability)?.label ?? capability;
  return (
    <div className="flex flex-col gap-8 pb-8 pt-2">
      <div>
        <p className="text-xs font-black uppercase tracking-[0.2em] text-[var(--kl-accent-text)]">{copy.kicker}</p>
        <h1 className="mt-2 font-display text-4xl font-bold tracking-[-0.03em] sm:text-5xl">{copy.heading}</h1>
        <p className="mt-3 max-w-2xl text-base leading-relaxed">{copy.lead}</p>
      </div>
      <DepartureBoard
        rows={rows}
        clock={healthAt ? formatBoardClock(new Date(healthAt)) : "--:-- UTC"}
        title={copy.statusBoard}
        subtitle={copy.statusBoardLabel}
        caption={copy.statusBoardLabel}
        busy={healthAt === null}
      />
      <section aria-labelledby="desk-try-one">
        <h2 id="desk-try-one" className="text-xs font-black uppercase tracking-[0.16em]">
          {copy.tryOne}
        </h2>
        <p className="mt-1 text-sm text-muted">{copy.tryOneHint}</p>
        <ul className="mt-3 flex flex-col gap-2">
          {starters.map((starter) => (
            <li key={starter.id}>
              <button
                type="button"
                onClick={() => onPick(sentenceOf(starter.sentence))}
                className="flex min-h-12 w-full flex-wrap items-center gap-3 border-2 border-control bg-surface px-3 py-2 text-left text-fg hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[var(--kl-focus)] motion-reduce:hover:translate-y-0"
              >
                <span className="inline-flex min-w-16 justify-center border-2 border-[#1A1A1A] bg-[#FFD60A] px-2 py-0.5 text-[11px] font-black uppercase tracking-wider text-[#1A1A1A]">
                  {label(starter.capability)}
                </span>
                <span className="min-w-0 flex-1 break-words font-code text-sm">{sentenceOf(starter.sentence)}</span>
                <span className="flex shrink-0 items-center gap-1">
                  {starter.networks.map((network) => (
                    <LineBullet key={network} line={LINES[network]} />
                  ))}
                  {starter.networks.some((network) => CHAINS[network].lane === "testnet") ? (
                    <span className="kd-yard-ribbon ml-1 px-1.5 text-[11px] font-black uppercase">{copy.testYard}</span>
                  ) : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
