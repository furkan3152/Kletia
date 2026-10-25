/**
 * The empty desk (Card machine): a greeting, the one question, and
 * "Try one" starters that fill the composer without sending anything, filtered by what the
 * deployment offers and re-phrased from the departure. The first three are printed as idea
 * cards, the rest as chips. Network status lives in the machine panel (and, on phones, in the
 * one-line strip here).
 */
import { CHAINS, type NetworkKey } from "@kletia/core";

import { Icon, Led, networkIcon, type IconName } from "../../kit";
import { playSound } from "../../kit/sound";
import { DESK_COPY } from "../content/copy";
import { fillStarterAddress, STARTER_CAPABILITIES, startersFor, type NetworkActions } from "../content/starters";
import type { Departure, HealthReading } from "../state/deskModel";
import { useDeskActions } from "./deskContext";
import { todayRows } from "./machine/machineModel";

const copy = DESK_COPY.empty;

const CAPABILITY_ICON: Record<string, IconName> = { swap: "swap", bridge: "bridge", send: "send", lend: "earn", stake: "lido", test: "flip" };

export interface DeskEmptyStateProps {
  readonly departure: Departure;
  readonly actions: NetworkActions;
  readonly health: Readonly<Partial<Record<NetworkKey, HealthReading>>>;
  readonly healthAt: string | null;
  readonly onPick: (sentence: string) => void;
}

/** "Good morning" by the visitor's clock. */
function partOfDay(date = new Date()): string {
  const hour = date.getHours();
  return hour < 5 ? "evening" : hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
}

/** The amount a starter moves ("25 USDC"), for the idea card's big number. */
function amountOf(sentence: string): string | null {
  return /\b(\d[\d,.]*\s+[A-Za-z][A-Za-z0-9]*)/u.exec(sentence)?.[1] ?? null;
}

export function DeskEmptyState({ departure, actions, health, healthAt, onPick }: DeskEmptyStateProps) {
  const starters = startersFor({ departure, actions, featuredOnly: true });
  // A test-yard `<address>` is the connected wallet's own address, or left for Kletia to ask: never inserted as is.
  const { accounts } = useDeskActions();
  const sentenceOf = (sentence: string) => fillStarterAddress(sentence, { evm: accounts.evm?.address ?? null, solana: accounts.solana?.address ?? null });
  const label = (capability: string) => STARTER_CAPABILITIES.find((entry) => entry.id === capability)?.label ?? capability;
  const who = accounts.evm?.address ?? accounts.solana?.address ?? null;
  const live = todayRows(health, null)[0]?.value ?? null;
  const answering = Object.values(health).filter((reading) => reading?.ok).length;
  const ideas = starters.slice(0, 3);
  const chips = starters.slice(3);
  const pick = (sentence: string) => {
    playSound("key", 0.6);
    onPick(sentenceOf(sentence));
  };
  return (
    <div className="kd-empty">
      <p className="kd-empty-strip" role="status">
        <Led tone={healthAt === null || live === null ? "off" : answering > 0 ? "on" : "magenta"} />
        {healthAt === null || live === null ? copy.statusBoardLabel : copy.networksLive(live)}
      </p>
      <div>
        <p className="kd-greet">{copy.greeting(partOfDay(), who ? `${who.slice(0, 6).toLowerCase()}` : "")}</p>
        <h1 className="kd-hello">{copy.heading}</h1>
        <p className="kd-lede">{copy.lead}</p>
      </div>
      <section aria-labelledby="desk-try-one" className="kd-ideas">
        <div className="kd-ideas-h">
          <h2 id="desk-try-one" className="k-eng">
            {copy.tryOne}
          </h2>
          <span className="k-muted">{copy.tryOneHint}</span>
        </div>
        <ul className="kd-ideas-row">
          {ideas.map((starter) => {
            const sentence = sentenceOf(starter.sentence);
            const testYard = starter.networks.some((network) => CHAINS[network].lane === "testnet");
            return (
              <li key={starter.id}>
                <button type="button" className="kd-idea" onClick={() => pick(starter.sentence)}>
                  <span className="kd-idea-top">
                    <Icon name={CAPABILITY_ICON[starter.capability] ?? "arr"} />
                    {label(starter.capability)}
                    <span className="kd-idea-nets" aria-hidden="true">
                      {starter.networks.map((network) => (
                        <Icon key={network} name={networkIcon(network)} />
                      ))}
                    </span>
                  </span>
                  <b className="kd-idea-n">{amountOf(sentence) ?? label(starter.capability)}</b>
                  <span className="kd-idea-t">{sentence}</span>
                  <span className="kd-idea-go">
                    {testYard ? <span className="kd-yard-ribbon">{copy.testYard}</span> : null}
                    {copy.askKletia}
                    <Icon name="arr" />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {chips.length > 0 ? (
          <ul className="kd-sugs">
            {chips.map((starter) => (
              <li key={starter.id}>
                <button type="button" className="k-chip" onClick={() => pick(starter.sentence)}>
                  <Icon name={CAPABILITY_ICON[starter.capability] ?? "arr"} />
                  <span className="kd-sug-t">{sentenceOf(starter.sentence)}</span>
                  {starter.networks.some((network) => CHAINS[network].lane === "testnet") ? <span className="kd-yard-ribbon">{copy.testYard}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
