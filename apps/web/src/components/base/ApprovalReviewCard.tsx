import { ShieldAlert } from "lucide-react";

import type { NetworkMode } from "../../config/networks";
import type { TransactionApproval } from "../../hooks/useTransactionExecutor";

interface ApprovalReviewCardProps {
  approvals: TransactionApproval[];
  network: NetworkMode;
}

const shortAddress = (address: string) =>
  `${address.slice(0, 8)}…${address.slice(-6)}`;

export function ApprovalReviewCard({
  approvals,
  network,
}: ApprovalReviewCardProps) {
  const exactApprovals = approvals.filter(({ amount }) => amount > 0n);
  if (exactApprovals.length === 0) return null;

  return (
    <div className="border-[3px] border-[#1A1A1A] bg-[#FFE4A3] p-3 text-[#1A1A1A] shadow-[3px_3px_0_#1A1A1A]">
      <div className="flex items-center gap-2 text-[11px] font-black uppercase tracking-wide">
        <ShieldAlert className="h-4 w-4" strokeWidth={3} />
        Approval review · {exactApprovals.length} exact allowance
      </div>
      <div className="mt-2 space-y-2">
        {exactApprovals.map((approval) => (
          <div
            key={`${approval.token}:${approval.spender}`}
            className="border-[2px] border-[#1A1A1A] bg-white p-2 text-[10px] font-bold"
          >
            <div className="font-black uppercase">
              {approval.symbol || "ERC-20 token"} · exact atomic amount{" "}
              {approval.amount.toString()}
            </div>
            <div className="mt-1 break-all font-mono" title={approval.token}>
              Token: {shortAddress(approval.token)}
            </div>
            <div className="break-all font-mono" title={approval.spender}>
              Spender: {shortAddress(approval.spender)}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[10px] font-bold leading-relaxed">
        Unlimited approval kullanılmaz. Cüzdan{" "}
        {network === "base" ? "atomic" : "batch"} çağrıyı desteklemiyorsa
        approval ana işlemden önce ayrı bir işlem olabilir; ana işlem
        tamamlanmazsa kalan allowance&apos;ı cüzdanınızdan gözden geçirip revoke
        edin.
      </p>
    </div>
  );
}
