/**
 * A network-engine task: the legacy Base, Arbitrum One or Arc chat engine
 * plans the sentence on its own network, and its messages for this task
 * render inline (route list, approval review, Execute route, the engine's
 * cards), moved unchanged from the old console. The wrong-chain bar and
 * every execution guard live in the legacy chunk, which loads on the first
 * engine task.
 */
import { lazy, Suspense, useEffect, useSyncExternalStore } from "react";
import { CHAINS } from "@kletia/core";

import { DESK_COPY } from "../content/copy";
import { useDeskActions } from "../shell/deskContext";
import type { TaskRecord } from "../state/deskStore";
import { getDeskStore } from "../state/deskStore";
import { claimSubmission, getEngine, subscribeEngines } from "./engineRegistry";
import { TaskTicket } from "./TaskTicket";

const LegacyTaskBody = lazy(() => import("../legacy").then((module) => ({ default: module.LegacyTaskBody })));
const LegacyEngineControls = lazy(() => import("../legacy").then((module) => ({ default: module.LegacyEngineControls })));

const copy = DESK_COPY.engine;

export function EngineTaskBody({ task }: { readonly task: TaskRecord }) {
  const actions = useDeskActions();
  const network = task.engine.kind === "network" ? task.engine.network : "base";
  const engine = useSyncExternalStore(subscribeEngines, () => getEngine(network), () => null);
  const name = CHAINS[network].name;

  // The sentence goes to the engine once, tagged with the task's thread.
  useEffect(() => {
    if (!engine || !task.sentence || task.restored) return;
    if (!claimSubmission(task.id)) return;
    void engine.submitIntent(task.sentence, { threadId: task.id, semanticPlanner: "deterministic_only" });
  }, [engine, task.id, task.restored, task.sentence]);

  // An engine task stays "engine" while its thread is open; the title follows the sentence.
  useEffect(() => {
    if (task.status !== "engine") getDeskStore().getState().patchTask(task.id, { status: "engine" });
  }, [task.id, task.status]);

  const why =
    task.engine.kind === "network"
      ? task.engine.why === "tool"
        ? copy.whyTool(copy.names[network])
        : task.engine.why === "offer"
          ? copy.whyOffer(CHAINS[network].shortName)
          : copy.whyFallback(CHAINS[network].shortName)
      : "";
  const messages = engine ? engine.messages.filter((message) => message.threadId === task.id) : [];
  const consentHere = engine?.pendingPrivacyDecision?.threadId === task.id;

  return (
    <>
      <TaskTicket task={task} ends={{ from: network, to: network }} departureLine={null}>
        <p className="mt-3 text-sm font-semibold">
          {why} {copy.signsOn(name)}
        </p>
      </TaskTicket>
      <div className="kd-engine">
        {engine ? (
          <Suspense fallback={<p className="text-sm font-semibold" role="status">{copy.loading}</p>}>
            <LegacyTaskBody engine={engine} messages={messages} onPrompt={(prompt) => actions.fill(prompt, { engine: network })} />
            {consentHere ? <LegacyEngineControls engine={engine} /> : null}
          </Suspense>
        ) : (
          <p className="text-sm font-semibold" role="status">
            {copy.loading}
          </p>
        )}
      </div>
    </>
  );
}
