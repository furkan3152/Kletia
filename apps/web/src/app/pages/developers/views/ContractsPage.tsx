import ContractsPanel from "../contracts/ContractsPanel";
import { KeyGate } from "../shell/KeyGate";
import { PortalPageHeader } from "../shell/PortalPageHeader";

/** Contracts (`/developers/contracts`): today's contracts panel under the portal header and key gate. */
export default function ContractsPage() {
  return (
    <>
      <PortalPageHeader
        title="Contracts"
        intro="Register your own EVM contract functions or Solana Actions, test them with the review your users will see, and reverify after an upgrade. Kletia pins the code and simulates every call; it does not audit your contract."
      />
      <KeyGate purpose="list, register, test and reverify your contracts" agentKeys>
        <ContractsPanel />
      </KeyGate>
    </>
  );
}
