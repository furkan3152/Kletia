import { AlertTriangle, CheckCircle2, ShieldCheck } from "lucide-react";
import type { IntentEntityResolution } from "../../types";
import { collectEntityResolutionWarnings } from "../../security/entityResolution";

type Props = {
  evidence: IntentEntityResolution;
};

const ROLE_LABELS: Record<string, string> = {
  tokenIn: "Input",
  tokenOut: "Output",
  collateralToken: "Collateral",
  borrowToken: "Debt",
};

const shortAddress = (address: string): string =>
  `${address.slice(0, 8)}…${address.slice(-6)}`;

const securityLabel = (status: string): string => {
  if (status === "manifest_verified") return "Manifest verified";
  if (status === "provider_passed") return "Live scan passed";
  return "Registry reviewed";
};

export function EntityResolutionEvidenceCard({ evidence }: Props) {
  const basenameRecipients = evidence.recipients.filter(
    (recipient) => recipient.matchedBy === "basename",
  );
  const warnings = collectEntityResolutionWarnings(evidence);

  return (
    <div className="mt-5 w-full border-[3px] border-[#1A1A1A] bg-[#BFF7FF] p-3 text-[#1A1A1A] shadow-[4px_4px_0_#1A1A1A] sm:w-80 md:w-[450px] md:p-4">
      <div className="flex items-center justify-between gap-3 border-b-[3px] border-[#1A1A1A] pb-2">
        <span className="flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.16em] md:text-xs">
          <ShieldCheck className="h-4 w-4" />
          Intent asset proof
        </span>
        <span className="border-[2px] border-[#1A1A1A] bg-[#86EFAC] px-2 py-1 text-[9px] font-black uppercase">
          Hard gates passed
        </span>
      </div>

      {evidence.assets.length > 0 && (
        <div className="mt-3 grid gap-2">
          {evidence.assets.map((asset) => (
            <div
              key={asset.role}
              className="border-[2px] border-[#1A1A1A] bg-white p-2.5 text-xs font-bold"
            >
              <div className="flex items-start justify-between gap-3">
                <span>
                  <span className="block text-[9px] font-black uppercase text-gray-600">
                    {ROLE_LABELS[asset.role] || asset.role}
                  </span>
                  <span className="block text-sm font-black">
                    {asset.canonicalSymbol} · {asset.displayName}
                  </span>
                </span>
                <span className="shrink-0 border-[2px] border-[#1A1A1A] bg-[#D9F99D] px-2 py-1 text-[9px] font-black">
                  {asset.trustScore}/100
                </span>
              </div>
              <div className="mt-1 text-[9px] font-bold uppercase leading-relaxed">
                {securityLabel(asset.security.status)} ·{" "}
                {asset.security.provider}
                {" · "}
                {asset.matchedBy.replace(/_/gu, " ")}
                {" · "}
                {asset.actionCompatibility.executionDecimals} decimals
              </div>
              {asset.address && (
                <div className="mt-1 font-mono text-[9px] font-bold">
                  {shortAddress(asset.address)}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {evidence.protocol && (
        <div className="mt-2 flex items-center gap-2 border-[2px] border-[#1A1A1A] bg-white p-2 text-[10px] font-bold">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          Protokol:{" "}
          <span className="font-black">{evidence.protocol.canonical}</span>(
          {evidence.protocol.matchedBy.replace(/_/gu, " ")})
        </div>
      )}

      {evidence.recipients.map((recipient) => (
        <div
          key={`${recipient.resolvedAddress}:${recipient.transferIndex ?? "single"}`}
          className="mt-2 border-[2px] border-[#1A1A1A] bg-white p-2 text-[10px] font-bold"
        >
          <span className="font-black">
            Recipient
            {recipient.transferIndex !== undefined
              ? ` #${recipient.transferIndex + 1}`
              : ""}
            :
          </span>{" "}
          {recipient.basename || shortAddress(recipient.resolvedAddress)}
          {recipient.basename && (
            <span className="mt-1 block font-mono text-[9px]">
              → {shortAddress(recipient.resolvedAddress)} · Re-verified before signing
            </span>
          )}
        </div>
      ))}

      {warnings.length > 0 && (
        <div className="mt-3 border-[3px] border-[#1A1A1A] bg-[#FFF36D] p-2.5 text-[10px] font-bold leading-relaxed">
          <div className="mb-1 flex items-center gap-1 font-black uppercase">
            <AlertTriangle className="h-4 w-4" /> Warnings
          </div>
          {warnings.slice(0, 6).map((warning, index) => (
            <div key={`${index}:${warning}`}>• {warning}</div>
          ))}
        </div>
      )}

      <p className="mt-3 border-t-[2px] border-[#1A1A1A] pt-2 text-[9px] font-bold leading-relaxed">
        The trust score only explains the proof; it cannot override strict security gates like address, network, action match, allowlist, simulation, or timeout.
        {basenameRecipients.length > 0
          ? " Basename records may change; they are re-resolved immediately before each signature."
          : ""}
      </p>
    </div>
  );
}
