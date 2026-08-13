import {
  useAccount,
  useChainId,
  useConfig,
  usePublicClient,
  useWriteContract,
} from "wagmi";
import { getAccount } from "@wagmi/core";
import { useState } from "react";
import { getAddress, type Abi, type Address } from "viem";
import {
  getNetworkByChainId,
  type NetworkDefinition,
} from "../config/networks";
import { BACKEND_URL } from "../config/runtime";

type SecureWriteContractArgs = {
  securityAction: string;
  address: Address;
  abi: Abi | readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
  chainId?: number;
  value?: bigint;
};

type SecureMutationOptions = {
  onError?: (error: Error) => void;
};

const SECURITY_ACTION_FUNCTIONS: Readonly<Record<string, ReadonlySet<string>>> =
  {
    x402_factory_create: new Set(["createGateway"]),
    x402_gateway_admin: new Set(["setPrice", "withdraw"]),
  };

const safeSecurityErrorMessage = (
  error: unknown,
  fallback = "Güvenlik kontrolü başarısız.",
): string => {
  if (!(error instanceof Error)) return fallback;
  const sanitized = error.message
    .replace(/https?:\/\/[^\s"'<>]+/giu, "[redacted-url]")
    .replace(
      /\b(?:authorization|signature|api[-_ ]?key)\b\s*[:=]\s*[^\s,;]+/giu,
      "[redacted-credential]",
    )
    .replace(/\b0x[a-f\d]{96,}\b/giu, "[redacted-payload]")
    .replace(/\b[A-Za-z\d+/_-]{80,}={0,2}\b/gu, "[redacted-payload]")
    .trim();
  return sanitized || fallback;
};

export function useSecureWriteContract() {
  const {
    writeContract: originalWriteContract,
    writeContractAsync: originalWriteContractAsync,
    ...rest
  } = useWriteContract();
  const { address: account } = useAccount();
  const chainId = useChainId();
  const wagmiConfig = useConfig();
  const publicClient = usePublicClient();
  const [isCheckingSecurity, setIsCheckingSecurity] = useState(false);
  const [securityError, setSecurityError] = useState<string | null>(null);

  const assertWalletContext = (
    expectedAccount: `0x${string}`,
    expectedChainId: number,
  ) => {
    const current = getAccount(wagmiConfig);
    if (
      !current.isConnected ||
      !current.address ||
      getAddress(current.address) !== getAddress(expectedAccount) ||
      current.chainId !== expectedChainId ||
      publicClient?.chain?.id !== expectedChainId
    ) {
      throw new Error(
        "Cüzdan hesabı veya ağı güvenlik kontrolü sırasında değişti; işlem iptal edildi.",
      );
    }
  };

  const checkWebacySecurity = async (
    address: string,
    network: NetworkDefinition,
    securityAction: string,
  ) => {
    if (!address) {
      throw new Error("Güvenlik kontrolü için hedef adres eksik.");
    }
    const target = getAddress(address);
    const normalizedAction = securityAction.trim().toLowerCase();
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(normalizedAction)) {
      throw new Error("Güvenlik kontrolü için geçerli bir action gerekli.");
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12_000);
    try {
      const requestUrl = new URL(
        `${BACKEND_URL}/api/webacy/scan/${target}`,
        window.location.origin,
      );
      requestUrl.searchParams.set("network", network.key);
      requestUrl.searchParams.set("chainId", String(network.chainId));
      requestUrl.searchParams.set("action", normalizedAction);
      const res = await fetch(requestUrl.toString(), {
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "X-Kletia-Network": network.key,
          "X-Kletia-Chain-Id": String(network.chainId),
        },
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || data?.status !== "success") {
        throw new Error(
          data?.message ||
            "Güvenlik servisi hedefi doğrulayamadı; işlem gönderilmedi.",
        );
      }

      const expectedSource =
        network.key === "arc" ? "arc_manifest+rpc_bytecode" : "webacy";
      const expectedTargetPolicy =
        normalizedAction === "x402_gateway_admin" ||
        normalizedAction === "x402_gateway_payment"
          ? "base_x402_factory_provenance"
          : "network_action_allowlist";
      if (
        data.network !== network.key ||
        data.chainId !== network.chainId ||
        data.source !== expectedSource ||
        !data.address ||
        getAddress(data.address) !== target ||
        data.isContract !== true ||
        data.actionBound !== true ||
        data.action !== normalizedAction ||
        data.targetPolicy !== expectedTargetPolicy ||
        data.decision !== "approved" ||
        data.approved === false ||
        !Number.isFinite(data.riskScore) ||
        data.riskScore > 50
      ) {
        const tags = Array.isArray(data.tags)
          ? ` Riskler: ${data.tags.join(", ")}`
          : "";
        throw new Error(`Güvenlik politikası işlemi engelledi.${tags}`);
      }
      return data;
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        throw new Error(
          "Güvenlik servisi zaman aşımına uğradı; kontrolsüz işlem gönderilmedi.",
          { cause: error },
        );
      }
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  };

  const runChecks = async (args: SecureWriteContractArgs) => {
    if (!publicClient || !account) {
      throw new Error("İşlem güvenliği için cüzdan bağlantısı gerekiyor.");
    }
    const network = getNetworkByChainId(chainId);
    if (!network) {
      throw new Error(`Desteklenmeyen chain ID: ${chainId}.`);
    }
    if (args.chainId !== undefined && args.chainId !== network.chainId) {
      throw new Error("İşlem isteğindeki chain ID aktif ağla eşleşmiyor.");
    }
    const allowedFunctions =
      SECURITY_ACTION_FUNCTIONS[args.securityAction.trim().toLowerCase()];
    if (!allowedFunctions || !allowedFunctions.has(args.functionName)) {
      throw new Error(
        "Güvenlik action alanı bu kontrat fonksiyonuna bağlı değil.",
      );
    }

    const expectedAccount = getAddress(account);
    const { securityAction, ...contractArgs } = args;
    assertWalletContext(expectedAccount, network.chainId);
    await checkWebacySecurity(contractArgs.address, network, securityAction);
    assertWalletContext(expectedAccount, network.chainId);
    await publicClient.simulateContract({
      ...contractArgs,
      account: expectedAccount,
    } as Parameters<typeof publicClient.simulateContract>[0]);
    assertWalletContext(expectedAccount, network.chainId);

    return {
      account: expectedAccount,
      chainId: network.chainId,
      contractArgs,
    };
  };

  const writeContract = async (
    args: SecureWriteContractArgs,
    options?: SecureMutationOptions,
  ) => {
    setIsCheckingSecurity(true);
    setSecurityError(null);
    try {
      const context = await runChecks(args);
      assertWalletContext(context.account, context.chainId);
      return originalWriteContract(
        {
          ...context.contractArgs,
          account: context.account,
          chainId: context.chainId,
        } as Parameters<typeof originalWriteContract>[0],
        options as Parameters<typeof originalWriteContract>[1],
      );
    } catch (error) {
      const errMessage = safeSecurityErrorMessage(error);
      setSecurityError(errMessage);
      if (options?.onError) {
        options.onError(new Error(errMessage));
      }
      return undefined;
    } finally {
      setIsCheckingSecurity(false);
    }
  };

  const writeContractAsync = async (
    args: SecureWriteContractArgs,
    options?: SecureMutationOptions,
  ) => {
    setIsCheckingSecurity(true);
    setSecurityError(null);
    try {
      const context = await runChecks(args);
      assertWalletContext(context.account, context.chainId);
      return await originalWriteContractAsync(
        {
          ...context.contractArgs,
          account: context.account,
          chainId: context.chainId,
        } as Parameters<typeof originalWriteContractAsync>[0],
        options as Parameters<typeof originalWriteContractAsync>[1],
      );
    } catch (error) {
      const errMessage = safeSecurityErrorMessage(error);
      setSecurityError(errMessage);
      throw new Error(errMessage, { cause: error });
    } finally {
      setIsCheckingSecurity(false);
    }
  };

  return {
    ...rest,
    writeContract,
    writeContractAsync,
    isCheckingSecurity,
    securityError,
    clearSecurityError: () => setSecurityError(null),
  };
}
