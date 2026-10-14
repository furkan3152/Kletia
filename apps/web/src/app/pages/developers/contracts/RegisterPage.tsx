import type { ContractView } from "@kletia/core";

import { navigate } from "../../../routes/history";
import { ButtonLink } from "../../../site/ui/Button";
import { cx, INK_BORDER, SURFACE, TEXT_MUTED } from "../../../site/ui/styles";
import { toast } from "../../../site/ui/toast";
import { portalKeyKind, useSessionKey } from "../keys/sessionKey";
import { KeyGate } from "../shell/KeyGate";
import { PortalPageHeader } from "../shell/PortalPageHeader";
import { registerVmOf } from "./contractRows";
import { RegisterContractWizard } from "./RegisterContractWizard";
import { SolanaActionForm } from "./SolanaActionForm";

function RegisterForm({ vm }: { readonly vm: "evm" | "svm" }) {
  const { key } = useSessionKey();
  if (portalKeyKind(key) !== "developer") {
    return (
      <div className={cx("flex flex-col items-start gap-3 p-5 sm:p-6", INK_BORDER, SURFACE)}>
        <p className="font-display text-title font-bold">This key cannot register contracts here</p>
        <p className={cx("max-w-2xl text-sm", TEXT_MUTED)}>
          Registering takes a developer key (kl_dev_), or an agent key whose rule book grants permissions.registerContracts (through the API or
          the CLI).
        </p>
        <ButtonLink to="/developers/contracts" size="sm" variant="secondary">
          Back to the contracts
        </ButtonLink>
      </div>
    );
  }
  // After registering, the new registration's own page (with its pending countdown, test and domain file).
  const onRegistered = (contract: ContractView) => {
    toast.success(`Registered ${contract.integrator.name}`, { description: contract.id });
    navigate(`/developers/contracts/${contract.id}`);
  };
  const onCancel = () => navigate("/developers/contracts");
  return vm === "svm" ? <SolanaActionForm apiKey={key} onRegistered={onRegistered} onCancel={onCancel} /> : <RegisterContractWizard apiKey={key} onRegistered={onRegistered} onCancel={onCancel} />;
}

/** Register (`/developers/contracts/new?vm=evm|svm`): the EVM wizard or the Solana Action form on its own page. */
export function RegisterPage({ search }: { readonly search: URLSearchParams }) {
  const vm = registerVmOf(search);
  return (
    <>
      <PortalPageHeader
        title={vm === "svm" ? "Register a Solana Action" : "Register an EVM contract"}
        back={{ label: "Contracts", to: "/developers/contracts" }}
        intro={
          vm === "svm"
            ? "Point Kletia at your Solana Actions endpoint and the programs it may touch. Kletia pins the programs and simulates every transaction it returns."
            : "Inspect the contract, choose the functions users may call, bind their arguments and the events that prove success. Kletia pins the code and simulates every call."
        }
        actions={
          <ButtonLink to={vm === "svm" ? "/developers/contracts/new?vm=evm" : "/developers/contracts/new?vm=svm"} variant="secondary" size="sm">
            {vm === "svm" ? "Register an EVM contract instead" : "Register a Solana Action instead"}
          </ButtonLink>
        }
      />
      <KeyGate purpose="register your own contracts" agentKeys>
        <RegisterForm key={vm} vm={vm} />
      </KeyGate>
    </>
  );
}
