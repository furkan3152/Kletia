import { useEffect, useState } from "react";
import {
  CircleAlert,
  DatabaseZap,
  ExternalLink,
  Loader2,
  ShieldCheck,
} from "lucide-react";
import { getAddress, isAddress } from "viem";

import { NETWORKS } from "../../../config/networks";
import { BACKEND_URL } from "../../../config/runtime";

const REGISTRY_ADDRESS = getAddress(
  "0x4A587b315472Dd452B2FbC42366B16dCC267ae34",
);
const REGISTRY_CODEHASH =
  "0xc84213a5efaeec9822ef03756eccea7271f3c1ad75a0a75ef29f304f7d6d1afb";
const TIMELOCK_ADDRESS = getAddress(
  "0x1B0D1720a9b67Bac0a72E671A69f2772C0BaA47F",
);
const GUARDIAN_SAFE_ADDRESS = getAddress(
  "0xCae3520A4348BEB2b74Ef52E8be2dE06f57fC0Bc",
);
const REQUEST_TIMEOUT_MS = 8_000;

type RegistryStatus = {
  address: string;
  observedAtBlock: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sameAddress = (value: unknown, expected: string): boolean =>
  typeof value === "string" &&
  isAddress(value, { strict: false }) &&
  getAddress(value) === expected;

const validateStatus = (value: unknown): RegistryStatus => {
  if (
    !isRecord(value) ||
    value.success !== true ||
    value.network !== "base" ||
    value.chainId !== NETWORKS.base.chainId ||
    !isRecord(value.data) ||
    value.data.status !== "available" ||
    value.data.available !== true ||
    !isRecord(value.data.registry) ||
    !sameAddress(value.data.registry.address, REGISTRY_ADDRESS) ||
    value.data.registry.runtimeCodehash !== REGISTRY_CODEHASH ||
    !sameAddress(value.data.registry.owner, TIMELOCK_ADDRESS) ||
    !sameAddress(value.data.registry.guardian, GUARDIAN_SAFE_ADDRESS) ||
    typeof value.data.registry.observedAtBlock !== "string" ||
    !/^[1-9]\d*$/u.test(value.data.registry.observedAtBlock) ||
    !isRecord(value.data.semantics) ||
    value.data.semantics.canonicalDiscovery !== "Coinbase CDP Bazaar" ||
    value.data.semantics.registryRole !== "supplemental_claim_attestation" ||
    value.data.semantics.claimProofRequired !== true ||
    value.data.semantics.affectsPaymentAuthorization !== false ||
    value.data.semantics.writeActionsExposed !== false
  ) {
    throw new Error("REGISTRY_STATUS_INVALID");
  }
  return {
    address: getAddress(value.data.registry.address as string),
    observedAtBlock: value.data.registry.observedAtBlock,
  };
};

const compactAddress = (address: string): string =>
  `${address.slice(0, 8)}…${address.slice(-6)}`;

export function X402AttestationRegistryStatus() {
  const [status, setStatus] = useState<RegistryStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let mounted = true;
    const timeout = window.setTimeout(() => {
      controller.abort();
      if (mounted) setUnavailable(true);
    }, REQUEST_TIMEOUT_MS);
    void (async () => {
      try {
        const response = await fetch(
          `${BACKEND_URL}/api/base/x402/attestations/status`,
          {
            method: "GET",
            headers: {
              Accept: "application/json",
              "X-Kletia-Network": "base",
              "X-Kletia-Chain-Id": String(NETWORKS.base.chainId),
            },
            credentials: "omit",
            redirect: "error",
            signal: controller.signal,
          },
        );
        if (!response.ok) throw new Error("REGISTRY_STATUS_UNAVAILABLE");
        const declaredLength = Number(response.headers.get("content-length"));
        if (Number.isFinite(declaredLength) && declaredLength > 32_768) {
          throw new Error("REGISTRY_STATUS_TOO_LARGE");
        }
        const body = await response.text();
        if (new TextEncoder().encode(body).byteLength > 32_768) {
          throw new Error("REGISTRY_STATUS_TOO_LARGE");
        }
        const verifiedStatus = validateStatus(JSON.parse(body) as unknown);
        if (mounted) setStatus(verifiedStatus);
      } catch {
        if (mounted) setUnavailable(true);
      } finally {
        window.clearTimeout(timeout);
      }
    })();
    return () => {
      mounted = false;
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, []);

  return (
    <div className="mt-4 border-[3px] border-[#1A1A1A] bg-[#F8FAFC] p-3 text-[#1A1A1A] dark:border-[#4B5563] dark:bg-[#172033] dark:text-white">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <DatabaseZap className="mt-0.5 h-5 w-5 shrink-0 text-[#0052FF]" />
          <div>
            <p className="text-[11px] font-black uppercase tracking-wider">
              Supplemental claim registry
            </p>
            <p className="mt-1 max-w-2xl text-[11px] font-bold text-gray-600 dark:text-slate-300">
              Coinbase CDP Bazaar remains canonical discovery. Registry records
              are independent claims, never payment permission or a safety
              guarantee.
            </p>
          </div>
        </div>

        {!status && !unavailable && (
          <span className="flex items-center gap-1 border-[2px] border-[#1A1A1A] bg-[#E2E8F0] px-2 py-1 text-[9px] font-black uppercase text-[#1A1A1A]">
            <Loader2 className="h-3 w-3 animate-spin" />
            Checking Base
          </span>
        )}
        {status && (
          <a
            href={`${NETWORKS.base.explorer.url}/address/${status.address}`}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 border-[2px] border-[#1A1A1A] bg-[#86EFAC] px-2 py-1 text-[9px] font-black uppercase text-[#1A1A1A]"
          >
            <ShieldCheck className="h-3 w-3" />
            Deployment verified
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
        {unavailable && (
          <span className="flex items-center gap-1 border-[2px] border-[#1A1A1A] bg-[#FFD166] px-2 py-1 text-[9px] font-black uppercase text-[#1A1A1A]">
            <CircleAlert className="h-3 w-3" />
            Fail-closed
          </span>
        )}
      </div>

      {status ? (
        <p className="mt-3 font-mono text-[10px] font-bold text-gray-600 dark:text-slate-300">
          {compactAddress(status.address)} · identity read at Base block{" "}
          {status.observedAtBlock}
        </p>
      ) : unavailable ? (
        <p className="mt-3 text-[10px] font-black uppercase text-[#9A3412] dark:text-[#FBBF24]">
          Registry identity could not be verified. No attestation label is
          available; Bazaar discovery and explicit payment approval remain
          separate.
        </p>
      ) : null}

      <p className="mt-2 border-t-[2px] border-[#1A1A1A] pt-2 text-[10px] font-bold dark:border-[#4B5563]">
        A service is never inferred as attested from its URL, payTo, or Bazaar
        metadata. Verification requires all five exact claim fields plus a named
        attester and remains read-only.
      </p>
    </div>
  );
}
