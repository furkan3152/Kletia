import "./homeBelow.css";

import type { ProtocolDescriptor } from "@kletia/core";

import type { ProtocolCount } from "../../site/protocolCount";
import { BackPanel } from "./BackPanel";
import { Coverage } from "./Coverage";
import { FeatureBinder } from "./FeatureBinder";
import { CtaSlab, HomeFaq, TrustPlates } from "./HomeEnd";
import type { HomeLive } from "./homeLive";
import { StoryTrack } from "./StoryTrack";

export { BasePlate } from "./HomeEnd";

export interface BelowFoldProps {
  readonly live: HomeLive;
  readonly protocols: readonly ProtocolDescriptor[];
  readonly counted: ProtocolCount;
}

/** Everything below the hero, loaded after the first paint with its own stylesheet. */
export function BelowFold({ live, protocols, counted }: BelowFoldProps) {
  return (
    <>
      <StoryTrack />
      <Coverage live={live} protocols={protocols} />
      <FeatureBinder />
      <BackPanel />
      <TrustPlates />
      <HomeFaq protocols={counted.protocols} ownContracts={counted.ownContracts} />
      <CtaSlab />
    </>
  );
}
