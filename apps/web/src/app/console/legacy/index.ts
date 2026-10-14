/**
 * The network engines' lazy chunk (console design 3.16 and 6.2): the legacy
 * Base, Arbitrum One and Arc chat engines moved out of the old console shell.
 *
 * The desk loads this module on its first engine task (or when a stored
 * cross-chain workflow needs resuming) and never imports it statically:
 *
 *   const LegacyEngineHost = lazy(() => import("../legacy"));
 *   const LegacyTaskBody = lazy(() => import("../legacy").then((m) => ({ default: m.LegacyTaskBody })));
 *   <LegacyEngineHost network="base">{(engine) => <LegacyTaskBody engine={engine} messages={…} onPrompt={…} />}</LegacyEngineHost>
 *
 * The default export owns one engine per network; task bodies render with it.
 */
export { LegacyEngineHost as default } from "./LegacyTaskBody";
export { LegacyEngineControls, LegacyEngineHost, LegacyTaskBody } from "./LegacyTaskBody";
export type { LegacyEngineHostProps, LegacyTaskBodyProps } from "./LegacyTaskBody";
export { LegacyMessageRow } from "./LegacyMessageBody";
export type { LegacyMessageRowProps } from "./LegacyMessageBody";
export { useLegacyEngine } from "./useLegacyEngine";
export type { LegacyEngine, LegacyEngineOptions, SubmitIntentOptions } from "./useLegacyEngine";
export { LegacyWorkflowResume, useLegacyWorkflowResume } from "./useLegacyWorkflowResume";
