import { CHAINS, PROTOCOLS, type ProtocolDescriptor } from "@kletia/core";

import { CodeShowcase } from "./CodeShowcase";
import { Faq } from "./Faq";
import { FeatureGrid } from "./FeatureGrid";
import { FinalCta } from "./FinalCta";
import { HeroSection } from "./HeroSection";
import { HowItWorks } from "./HowItWorks";
import { LiveStatus } from "./LiveStatus";
import { NetworkStrip } from "./NetworkStrip";
import { Pillars } from "./Pillars";
import { SecuritySection } from "./SecuritySection";
import { StatsBand } from "./StatsBand";
import { UseCases } from "./UseCases";
import { useHomeData } from "./useHomeData";

/** Home: product story, live figures, integration paths and the security model. */
export default function HomePage() {
  const data = useHomeData();
  const protocols: readonly ProtocolDescriptor[] = data.liveProtocols ? data.protocols.data! : PROTOCOLS;
  const networkCount = data.liveNetworks ? data.networks.data!.length : Object.keys(CHAINS).length;
  return (
    <>
      <HeroSection />
      <StatsBand data={data} />
      <NetworkStrip protocols={protocols} />
      <HowItWorks />
      <Pillars />
      <CodeShowcase />
      <FeatureGrid />
      <LiveStatus data={data} />
      <UseCases />
      <SecuritySection />
      <Faq networks={networkCount} protocols={protocols.length} />
      <FinalCta />
    </>
  );
}
