import { CHAINS, PROTOCOLS, type ProtocolDescriptor } from "@kletia/core";

import { CodeShowcase } from "./CodeShowcase";
import { Faq } from "./Faq";
import { FeatureGrid } from "./FeatureGrid";
import { FinalCta } from "./FinalCta";
import { HeroSection } from "./HeroSection";
import { HowItWorks } from "./HowItWorks";
import { NetworkStrip } from "./NetworkStrip";
import { Pillars } from "./Pillars";
import { SecuritySection } from "./SecuritySection";
import { StatusBoard } from "./StatusBoard";
import { UseCases } from "./UseCases";
import { useHomeData } from "./useHomeData";

/**
 * Home: the route map and its ticket, the departure board, the line index,
 * how a route runs, the ways in, the house rules and the security model.
 * Sections are numbered as platforms (01 to 09).
 */
export default function HomePage() {
  const data = useHomeData();
  const protocols: readonly ProtocolDescriptor[] = data.liveProtocols ? data.protocols.data! : PROTOCOLS;
  const networkCount = data.liveNetworks ? data.networks.data!.length : Object.keys(CHAINS).length;
  return (
    <>
      <HeroSection venues={protocols.length} />
      <StatusBoard data={data} />
      <NetworkStrip protocols={protocols} />
      <HowItWorks />
      <Pillars />
      <CodeShowcase />
      <FeatureGrid />
      <UseCases />
      <SecuritySection />
      <Faq networks={networkCount} protocols={protocols.length} />
      <FinalCta />
    </>
  );
}
