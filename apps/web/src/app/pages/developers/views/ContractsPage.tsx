import { ContractPage } from "../contracts/ContractPage";
import { CONTRACT_ID } from "../contracts/contractRows";
import { ContractsListPage } from "../contracts/ContractsListPage";
import { RegisterPage } from "../contracts/RegisterPage";
import { PortalPageHeader } from "../shell/PortalPageHeader";
import type { PortalPageProps } from "../shell/portalRoutes";
import { ButtonLink } from "../../../site/ui/Button";

/**
 * Contracts (`/developers/contracts`, `/new?vm=evm|svm`, `/:contractId`): the
 * registrations as table rows, the register page and one registration's
 * page with tabs (portal design 4.4.4).
 */
export default function ContractsPage({ param, search }: PortalPageProps) {
  if (param === null) return <ContractsListPage />;
  if (param === "new") return <RegisterPage search={search} />;
  if (CONTRACT_ID.test(param)) return <ContractPage key={param} contractId={param} search={search} />;
  return (
    <>
      <PortalPageHeader title="No contract here" back={{ label: "Contracts", to: "/developers/contracts" }} />
      <p className="pb-4 text-sm">Contract ids look like ct_ followed by 24 hex characters.</p>
      <ButtonLink to="/developers/contracts" variant="secondary" size="sm" className="self-start">
        Back to the contracts
      </ButtonLink>
    </>
  );
}
