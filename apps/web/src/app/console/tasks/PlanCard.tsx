/**
 * The printed plan card in its tray (Card machine): the desk's one hero
 * object. Front: the type band and serial, the route drawn on the art window (only the networks
 * and venues the plan touches), what you end up with, three facts (you pay, you get at least,
 * total fees from `totalFeesUsd`) and one key. Details flips it to the back: the legs, the
 * contracts, the conditions, the routes it beat and the sources.
 *
 * Every moment is bound to real state, never to a timer:
 * - print: the card advances out of the slot in four steps when its plan first arrives;
 * - plot: the pen plotter draws the route right after;
 * - sign: the action row becomes the step strip while the run is live; coins ride the rails as far
 *   as the API reports (legProgress), the travelled part turns lime;
 * - seal: the latch slams (and the desk shakes 2 px) when the first signature exists;
 * - settle: the stamp lands only when the API completed the intent and the run saw it;
 * - file: the card then flies into the binder and leaves its sleeve ("Show the card" brings it back);
 * - jam: a changed fare, expired quotes or a stopped run print a paper jam with Reprint.
 */
import "./conversation.css";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { IntentGraph, IntentPreview, IntentStep } from "@kletia/core";

import { CardActions, CardArt, CardBody, CardTray, Facts, Icon, Key, LinkButton, PrintedCard, Sleeve } from "../../kit";
import { animate, EASE, jamShake, reducedMotion } from "../../kit/motion";
import { playSound } from "../../kit/sound";
import { formatUsd, protocolName } from "../../site/intent/format";
import { formatUtcTime } from "../../site/format/utcTime";
import {
  cardFacts,
  cardType,
  legProgress,
  routeStops,
  signedShare,
  sortedSteps,
  type CardPhase,
  type LegProgress,
} from "./cardModel";
import { reveal } from "./reveal";
import { RouteArt } from "./RouteArt";


export interface CardJam {
  /** One plain sentence: what stopped and that nothing was sent. */
  readonly message: ReactNode;
  readonly onReprint?: () => void;
  readonly reprintLabel?: string;
}

export interface PlanCardProps {
  /** "C21E": the task's serial (the binder prints the same). */
  readonly serial: string;
  readonly intent: IntentGraph;
  readonly preview: IntentPreview | null;
  readonly phase: CardPhase;
  /** The executor's local step phases (signing, confirming...). */
  readonly stepPhases?: Readonly<Record<string, string>>;
  /** A wallet request is out for one of the steps and no outcome came back. */
  readonly signed: boolean;
  /** Print it now (its plan just arrived); otherwise it is already in the tray. */
  readonly print: boolean;
  /** The action row of the front while nothing is signing (Review and sign, Connect...). */
  readonly actions?: ReactNode;
  /** One line under the step strip while signing (pause reason, "check your wallet"). */
  readonly signingNote?: string | null;
  readonly walletFor?: (step: IntentStep) => string | null;
  readonly jam?: CardJam | null;
  /** The run watched this card before it settled: it may be filed into the binder. */
  readonly fileWhenSettled?: boolean;
  /** "09:41": when the plan was printed. */
  readonly printedAt?: string | null;
  /** Element that shakes 2 px with the latch and the stamp. */
  readonly shakeTarget?: () => Element | null;
}

const VERB: Readonly<Record<string, string>> = { bridge: "bridging", swap: "swapping", deposit: "depositing", withdraw: "withdrawing", stake: "staking", transfer: "sending" };

function stepWord(step: IntentStep): string {
  const kind = step.kind === "transfer" ? "send" : step.kind;
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

/** The line under the strip: the leg in front, from the real progress. */
function stripNote(steps: readonly IntentStep[], progress: readonly LegProgress[], phase: CardPhase, walletFor?: (step: IntentStep) => string | null): string {
  if (phase === "settled") {
    const last = steps[steps.length - 1];
    const network = last?.settlement?.kind === "cross-network" ? last.settlement.destinationNetwork : last?.network;
    return network ? `Settled on ${networkLabel(network)}` : "Settled";
  }
  const index = progress.findIndex((leg) => leg.state === "wallet" || leg.state === "moving" || leg.state === "failed");
  const leg = index >= 0 ? progress[index] : null;
  const step = index >= 0 ? steps[index] : null;
  const of = steps.length > 1 && index >= 0 ? ` · step ${index + 1} of ${steps.length}` : "";
  if (!leg || !step) return progress.every((entry) => entry.state === "done") ? "Every step is confirmed · waiting for the intent to settle" : "Preparing the next step";
  if (leg.state === "failed") return `Step ${index + 1} did not go through`;
  if (leg.state === "wallet") {
    const wallet = walletFor?.(step);
    return `Check your wallet${wallet ? ` (${wallet})` : ""}${of}`;
  }
  return `${protocolName(step.protocol)} is ${VERB[step.kind] ?? "working"}${of}`;
}

function networkLabel(network: string): string {
  const names: Record<string, string> = { arbitrum: "Arbitrum", optimism: "OP Mainnet", polygon: "Polygon", ethereum: "Ethereum", base: "Base", solana: "Solana", arc: "Arc" };
  return names[network] ?? network;
}

/** A value that flips in digit by digit when it changes (re-plans update the card in place). */
function Flip({ text }: { readonly text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const previous = useRef(text);
  useEffect(() => {
    if (previous.current === text) return;
    previous.current = text;
    const element = ref.current;
    if (!element || reducedMotion()) return;
    animate(element, [{ transform: "translateY(60%)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 420, easing: EASE.back(2.2) });
    for (let index = 0; index < Math.min(6, text.length); index += 1) window.setTimeout(() => playSound("tick", 0.5), index * 35);
  }, [text]);
  return (
    <span ref={ref} className="kd-flip">
      {text}
    </span>
  );
}

export function PlanCard({
  serial,
  intent,
  preview,
  phase,
  stepPhases = {},
  signed,
  print,
  actions,
  signingNote,
  walletFor,
  jam = null,
  fileWhenSettled = false,
  printedAt = null,
  shakeTarget,
}: PlanCardProps) {
  const [flipped, setFlipped] = useState(false);
  const [printing, setPrinting] = useState(print && !reducedMotion());
  const [filed, setFiled] = useState(false);
  const [shown, setShown] = useState(false);
  const move = useRef<HTMLDivElement>(null);
  const tray = useRef<HTMLDivElement>(null);
  const plan = useMemo(() => routeStops(intent), [intent]);
  const steps = useMemo(() => sortedSteps(intent.steps), [intent.steps]);
  const facts = cardFacts(intent, preview);
  const live = phase === "signing" || phase === "settled" || phase === "stopped";
  const progress = live ? legProgress(steps, stepPhases) : [];
  const coins = useMemo(() => Object.fromEntries(steps.map((step) => [step.id, { from: step.input?.symbol ?? "$", to: step.expectedOutput?.symbol ?? step.input?.symbol ?? "$" }])), [steps]);

  // Print: the slot widens, the motor runs, the card advances in four steps (sections ink in
  // bottom first as they pass the slot), the release slides it home, the foil develops.
  useLayoutEffect(() => {
    if (!printing) return undefined;
    const card = move.current;
    if (!card) return undefined;
    const sections = [...card.querySelectorAll<HTMLElement>(".k-card-face:not(.k-card-face--back) > *")].reverse();
    const timers: number[] = [];
    animate(tray.current?.querySelector(".k-slot"), [{ transform: "scaleX(.6)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 400, easing: EASE.back(2) });
    playSound("motor", 0.8);
    reveal(tray.current, "start");
    card.style.transform = "translateY(-80%)";
    sections.forEach((section, index) => animate(section, [{ opacity: 0 }, { opacity: 1 }], { duration: 250, delay: 450 + index * 200, fill: "backwards" }));
    [-60, -40, -20].forEach((y, index) =>
      timers.push(
        window.setTimeout(() => {
          animate(card, [{ transform: `translateY(${y - 20}%) translateX(${index % 2 ? 1.2 : -1.2}px)` }, { transform: `translateY(${y}%)` }], { duration: 130, easing: EASE.mech, fill: "persist" });
          playSound("step", 0.9);
        }, 400 + index * 230),
      ),
    );
    timers.push(
      window.setTimeout(() => {
        void animate(card, [{ transform: "translateY(-20%)" }, { transform: "none" }], { duration: 550, easing: EASE.back(1.5), fill: "persist" })
          ?.finished.catch(() => undefined)
          .finally(() => {
            card.style.transform = "";
          });
        playSound("slide");
        const article = card.querySelector<HTMLElement>(".k-card");
        animate(card.querySelector(".k-foil"), [{ opacity: 0, filter: "hue-rotate(-120deg) saturate(.2)" }, {}], { duration: 1600, delay: 500, easing: EASE.outPow(2) });
        animate(article, [{ "--sx": "120%" } as Keyframe, { "--sx": "-40%" } as Keyframe], { duration: 1000, delay: 400, easing: EASE.inOut(2) });
        animate(article, [{ transform: "perspective(900px) rotateY(-10deg)" }, { transform: "perspective(900px) rotateY(0deg)" }], { duration: 1300, delay: 400, easing: EASE.elastic(1, 0.4) });
      }, 400 + 3 * 230),
    );
    timers.push(window.setTimeout(() => setPrinting(false), 400 + 3 * 230 + 700));
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      card.style.transform = "";
    };
    // Once per printed card.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Paper jam: two advances' worth of shake, the card tilts half out, the jam sound.
  const jammed = Boolean(jam);
  const hadJam = useRef(jammed);
  useEffect(() => {
    if (jammed && !hadJam.current) {
      jamShake(move.current);
      playSound("jam");
    }
    hadJam.current = jammed;
  }, [jammed]);

  // File: settled and watched, the card lifts, flies into the binder and leaves its sleeve.
  const settled = phase === "settled";
  useEffect(() => {
    if (!settled || !fileWhenSettled || filed || shown) return undefined;
    const timer = window.setTimeout(() => {
      const card = move.current?.querySelector<HTMLElement>(".k-card");
      const target = [...document.querySelectorAll<HTMLElement>(".kd-binder, .kd-topbar [aria-label^='Binder']")].find((element) => element.offsetParent !== null);
      if (!card || !target || reducedMotion()) {
        setFiled(true);
        return;
      }
      const from = card.getBoundingClientRect();
      const to = target.getBoundingClientRect();
      const ghost = card.cloneNode(true) as HTMLElement;
      ghost.removeAttribute("aria-label");
      ghost.setAttribute("aria-hidden", "true");
      Object.assign(ghost.style, { position: "fixed", left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px`, margin: "0", zIndex: "90", pointerEvents: "none" });
      document.body.appendChild(ghost);
      card.style.visibility = "hidden";
      playSound("slide");
      const dx = to.left + to.width / 2 - (from.left + from.width / 2);
      const dy = to.top + to.height / 2 - (from.top + from.height / 2);
      const lift = animate(ghost, [{ transform: "none" }, { transform: "translateY(-14px) scale(1.04) rotate(-2deg)" }], { duration: 250, easing: EASE.outPow(2), fill: "forwards" });
      void lift?.finished
        .then(() => animate(ghost, [{ transform: "translateY(-14px) scale(1.04) rotate(-2deg)", opacity: 1 }, { transform: `translate(${dx}px, ${dy}px) scale(.1) rotate(-14deg)`, opacity: 0.2 }], { duration: 750, easing: EASE.in(3), fill: "forwards" })?.finished)
        .catch(() => undefined)
        .finally(() => {
          ghost.remove();
          playSound("drop");
          animate(target, [{ transform: "translateY(4px) scale(.94)" }, { transform: "none" }], { duration: 600, easing: EASE.elastic(1, 0.4) });
          setFiled(true);
        });
    }, 2400);
    return () => window.clearTimeout(timer);
  }, [fileWhenSettled, filed, settled, shown]);

  const share = signedShare(progress);
  const status = jammed ? "jammed · nothing was sent" : printing ? `printing card #${serial}` : filed && !shown ? `empty · #${serial} filed` : printedAt ? `card #${serial} · ${printedAt}` : `card #${serial}`;
  const latch = signed || settled ? (settled ? "SIGNED" : "SEALED") : null;

  if (filed && !shown) {
    return (
      <CardTray status={status} className="kd-tray">
        <div className="kd-sleeve-wrap">
          <Sleeve title={`Card #${serial} is in your binder`}>
            <LinkButton onClick={() => setShown(true)}>Show the card</LinkButton>
          </Sleeve>
        </div>
      </CardTray>
    );
  }

  const back = (
    <div className="kd-back">
      <CardBack intent={intent} steps={steps} />
      <CardActions>
        <LinkButton onClick={() => setFlipped(false)}>Back to the card</LinkButton>
      </CardActions>
    </div>
  );

  return (
    <div className="kd-cardturn">
      <div ref={tray} className="kd-traywrap">
        <CardTray status={status} className="kd-tray">
          <div ref={move} className="kd-cardmove" data-jam={jammed ? "" : undefined} {...(jammed ? { inert: "" } : {})}>
            <PrintedCard
              label={`Plan card ${serial}: ${intent.summary.title}`}
              type={cardType(intent)}
              serial={serial}
              flipped={flipped}
              latch={latch}
              stamp={settled ? "Settled" : null}
              {...(shakeTarget ? { shakeTarget } : {})}
              front={
                <>
                  <CardArt>
                    <RouteArt plan={plan} progress={progress} coins={coins} plot={print} plotDelay={print ? 1350 : 0} />
                  </CardArt>
                  <CardBody from={facts.from} title={<Flip text={facts.title} />} />
                  <Facts
                    rows={[
                      ["You pay", <Flip key="pay" text={facts.pay} />],
                      ["You get at least", <Flip key="min" text={facts.atLeast} />],
                      ["Total fees", <Flip key="fees" text={facts.fees} />],
                    ]}
                  />
                  {live ? (
                    <div className="kd-csteps">
                      <ol aria-label="Steps">
                        {steps.map((step, index) => {
                          const state = progress[index]?.state ?? "queued";
                          return (
                            <li key={step.id} className="kd-cs" data-state={state}>
                              <span className="kd-bulb" aria-hidden="true">
                                {state === "done" ? <Icon name="check" /> : state === "failed" ? <Icon name="x" /> : index + 1}
                              </span>
                              {stepWord(step)}
                              <span className="sr-only">{state === "done" ? ", done" : state === "wallet" ? ", in your wallet" : state === "moving" ? ", in flight" : state === "failed" ? ", failed" : ", queued"}</span>
                            </li>
                          );
                        })}
                      </ol>
                      <div className="kd-signbar" aria-hidden="true">
                        <i style={{ width: `${Math.round(share * 100)}%` }} />
                      </div>
                      <p className="kd-cs-note" role="status">
                        {signingNote ?? stripNote(steps, progress, phase, walletFor)}
                      </p>
                      <CardActions>
                        <LinkButton onClick={() => setFlipped(true)}>Details</LinkButton>
                      </CardActions>
                    </div>
                  ) : (
                    <CardActions>
                      <LinkButton onClick={() => setFlipped(true)}>Details</LinkButton>
                      <span className="kd-card-keys">{actions}</span>
                    </CardActions>
                  )}
                </>
              }
              back={back}
            />
          </div>
        </CardTray>
      </div>
      {jam ? (
        <div className="k-jam kd-jam" role="alert">
          <Icon name="warn" />
          <span>
            <b>Paper jam.</b> {jam.message}
          </span>
          {jam.onReprint ? (
            <Key tone="lime" size="sm" onClick={jam.onReprint}>
              {jam.reprintLabel ?? "Reprint"}
            </Key>
          ) : null}
        </div>
      ) : null}
      {filed && shown ? (
        <p className="kd-filed-note">
          <LinkButton onClick={() => setShown(false)}>Put it back in the binder</LinkButton>
        </p>
      ) : null}
    </div>
  );
}

/** The back: legs, contracts, conditions, the routes it beat, sources. */
function CardBack({ intent, steps }: { readonly intent: IntentGraph; readonly steps: readonly IntentStep[] }) {
  const routes = intent.interpretation.routes ?? [];
  const assumptions = intent.interpretation.assumptions ?? [];
  const providers = intent.interpretation.providersContacted ?? [];
  const expires = formatUtcTime(intent.expiresAt);
  const amount = (value: IntentStep["input"]) => (value ? `${value.formatted.length > 10 ? Number(value.formatted).toPrecision(6) : value.formatted} ${value.symbol}` : null);
  return (
    <div className="kd-back-body">
      <ol className="kd-legs-back">
        {steps.map((step, index) => {
          const destination = step.settlement?.kind === "cross-network" ? step.settlement.destinationNetwork : null;
          const where = destination ? `${networkLabel(step.network)} → ${networkLabel(destination)}` : networkLabel(step.network);
          const io = [amount(step.input), amount(step.minimumOutput) ? `at least ${amount(step.minimumOutput)}` : null].filter(Boolean).join(" → ");
          return (
            <li key={step.id}>
              <b>
                {index + 1} · {stepWord(step)} on {protocolName(step.protocol)}
              </b>
              <span>
                {where}
                {io ? ` · ${io}` : ""}
                {typeof step.estimatedSeconds === "number" ? ` · ~${Math.max(1, Math.round(step.estimatedSeconds))} s` : ""}
              </span>
            </li>
          );
        })}
      </ol>
      <dl className="kd-back-dl">
        <div>
          <dt>Contracts</dt>
          <dd>
            {steps
              .map((step) => `${protocolName(step.protocol)} on ${networkLabel(step.network)}${step.call?.target ? ` (${step.call.target.slice(0, 6)}…${step.call.target.slice(-4)})` : ""}`)
              .filter((value, index, all) => all.indexOf(value) === index)
              .join(", ")}
          </dd>
        </div>
        <div>
          <dt>Conditions</dt>
          <dd>
            {[...assumptions.map((assumption) => assumption.label), expires ? `Quotes hold until ${expires}` : null, `${intent.summary.signaturesRequired} signature${intent.summary.signaturesRequired === 1 ? "" : "s"}`, ...intent.warnings]
              .filter(Boolean)
              .join(" · ")}
          </dd>
        </div>
        {routes.some((route) => route.compared.length > 0) ? (
          <div>
            <dt>Routes it beat</dt>
            <dd>
              {routes
                .flatMap((route) => route.compared.map((entry) => (entry.excluded ? `${entry.label} (${entry.excluded})` : entry.score ? `${entry.label} ${formatUsd(entry.score.valueUsd) ?? ""}` : entry.label)))
                .slice(0, 6)
                .join(" · ")}
            </dd>
          </div>
        ) : null}
        {providers.length > 0 ? (
          <div>
            <dt>Sources</dt>
            <dd>
              Quotes from {providers.map((provider) => `${protocolName(provider.provider)}${provider.sawAccount ? " (saw your address)" : ""}`).join(", ")}
            </dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}
