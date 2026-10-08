import { CodeShowcase } from "./CodeShowcase";
import { FeatureGrid } from "./FeatureGrid";
import { FinalCta } from "./FinalCta";
import { HeroSection } from "./HeroSection";
import { HowItWorks } from "./HowItWorks";
import { LiveStatus } from "./LiveStatus";
import { NetworkStrip } from "./NetworkStrip";
import { Pillars } from "./Pillars";
import { SecuritySection } from "./SecuritySection";
import { UseCases } from "./UseCases";

/** Home: product story, live status and integration paths. */
export default function HomePage() {
  return (
    <>
      <HeroSection />
      <NetworkStrip />
      <HowItWorks />
      <Pillars />
      <CodeShowcase />
      <FeatureGrid />
      <LiveStatus />
      <UseCases />
      <SecuritySection />
      <FinalCta />
    </>
  );
}
