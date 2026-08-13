import { useCallback } from "react";
import {
  useAccount,
  useCapabilities,
  useChainId,
  useConfig,
  usePublicClient,
  useSendCalls,
  useSendTransaction,
} from "wagmi";
import { getAccount, waitForCallsStatus } from "@wagmi/core";
import {
  decodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  isAddress,
  keccak256,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { NETWORKS, getNetwork, type NetworkMode } from "../config/networks";
import type {
  BaseIntentRouterV2AdapterKind,
  RouteExecutionMode,
} from "../types";
import {
  BASE_LAUNCH_FACTORY_V2_ADDRESS,
  BASE_LAUNCH_FACTORY_V2_RUNTIME_CODEHASH,
} from "../networks/base/config/launchFactoryV2";
import { BACKEND_URL, BASE_PAYMASTER_ENABLED } from "../config/runtime";

const SECURITY_BLOCK_THRESHOLD = 50;
const BASE_MAINNET_CHAIN_ID = 8_453;

export type TransactionApproval = {
  token: Address;
  spender: Address;
  amount: bigint;
  symbol?: string;
};

export type NetworkTransactionPlan = {
  network: NetworkMode;
  chainId: number;
  action: string;
  executionMode?: RouteExecutionMode;
  atomicRequired?: boolean;
  to: Address;
  data: Hex;
  value: bigint;
  approvals?: TransactionApproval[];
  expiresAt?: number;
  userAddress?: Address;
  requireEoa?: boolean;
  policyTargets?: Address[];
  simulationReturnPolicy?: "uint256_zero";
  beforeSubmit?: () => Promise<void>;
  intentV2Authorities?: {
    adapterKind: BaseIntentRouterV2AdapterKind;
    router: Address;
    adapter: Address;
    target: Address;
    spender: Address;
    factory: Address;
    wrappedNative: Address;
  };
  launchFactoryV2Authority?: {
    factory: Address;
    runtimeCodehash: Hex;
    predictedAddress: Address;
    recipient: Address;
    totalSupply: bigint;
    name: string;
    symbol: string;
  };
};

export type TransactionExecutionResult = {
  hash: Hex;
  receipt: TransactionReceipt;
  gasEstimate: bigint;
};

type LogHandler = (message: string) => void;

type TargetWalletCapabilities = {
  atomic?: {
    status?: unknown;
  };
  paymasterService?: {
    supported?: unknown;
  };
};

export type BaseWalletExecutionCapabilities = {
  canUseAtomicCalls: boolean;
  canUsePaymaster: boolean;
};

export function resolveBaseWalletExecutionCapabilities(
  network: NetworkMode,
  chainId: number,
  capabilities: unknown,
): BaseWalletExecutionCapabilities {
  const isBaseMainnet = network === "base" && chainId === BASE_MAINNET_CHAIN_ID;
  if (!isBaseMainnet || !capabilities || typeof capabilities !== "object") {
    return {
      canUseAtomicCalls: false,
      canUsePaymaster: false,
    };
  }

  const targetCapabilities = (capabilities as Record<string, unknown>)[
    String(BASE_MAINNET_CHAIN_ID)
  ];
  if (!targetCapabilities || typeof targetCapabilities !== "object") {
    return {
      canUseAtomicCalls: false,
      canUsePaymaster: false,
    };
  }

  const { atomic, paymasterService } =
    targetCapabilities as TargetWalletCapabilities;
  const atomicStatus = atomic?.status;

  return {
    canUseAtomicCalls: atomicStatus === "ready" || atomicStatus === "supported",
    canUsePaymaster: paymasterService?.supported === true,
  };
}

export function buildAtomicCallBatch(
  missingApprovals: ReadonlyArray<{
    token: Address;
    data: Hex;
  }>,
  action: {
    to: Address;
    data: Hex;
    value: bigint;
  },
) {
  return [
    ...missingApprovals.map((approval) => ({
      to: approval.token,
      data: approval.data,
      value: 0n,
    })),
    action,
  ];
}

export function assertRequiredAtomicApprovalPath(
  atomicRequired: boolean,
  missingApprovalCount: number,
  available: boolean,
  stage: "capability" | "simulation",
) {
  if (!atomicRequired || missingApprovalCount === 0 || available) {
    return;
  }
  if (stage === "simulation") {
    throw new Error(
      "Base atomic paket simülasyonu kullanılamadığı için Kletia Intent Router V2 işlemi durduruldu. Sıralı approval fallback kullanılmadı.",
    );
  }
  throw new Error(
    "Kletia Intent Router V2, eksik token izni ile swap işlemini tek bir Base atomic paketinde yürütmelidir. Cüzdan atomic capability doğrulamadığı için hiçbir approval gönderilmedi.",
  );
}

export function assertIntentV2TransactionPlanBoundary(
  plan: NetworkTransactionPlan,
) {
  const isIntentRouterV2 = plan.executionMode === "kletia_intent_router_v2";
  if (!isIntentRouterV2) {
    if (
      plan.intentV2Authorities !== undefined ||
      plan.atomicRequired === true
    ) {
      throw new Error(
        "Typed Base V2 yetkileri yalnız Kletia Intent Router V2 işleminde kullanılabilir.",
      );
    }
    return;
  }

  const authorities = plan.intentV2Authorities;
  const positiveApprovals = (plan.approvals || []).filter(
    ({ amount }) => amount > 0n,
  );
  if (
    plan.network !== "base" ||
    plan.chainId !== BASE_MAINNET_CHAIN_ID ||
    plan.action.trim().toLowerCase() !== "swap" ||
    !authorities ||
    (authorities.adapterKind !== "uniswap_v2_compatible" &&
      authorities.adapterKind !== "uniswap_v3_swaprouter02") ||
    getAddress(plan.to) !== getAddress(authorities.router) ||
    plan.requireEoa === true ||
    plan.simulationReturnPolicy !== undefined ||
    plan.atomicRequired !== positiveApprovals.length > 0
  ) {
    throw new Error(
      "Kletia Intent Router V2 işlem planı Base swap, typed yetki ve atomic approval politikasına bağlı değil.",
    );
  }

  const expectedTargets = [
    authorities.adapter,
    authorities.target,
    authorities.spender,
    authorities.factory,
    authorities.wrappedNative,
  ].reduce<Address[]>((result, value) => {
    const normalized = getAddress(value);
    if (!result.some((item) => getAddress(item) === normalized)) {
      result.push(normalized);
    }
    return result;
  }, []);
  const suppliedTargets = plan.policyTargets || [];
  if (
    suppliedTargets.length !== expectedTargets.length ||
    suppliedTargets.some(
      (target, index) => getAddress(target) !== expectedTargets[index],
    ) ||
    new Set(suppliedTargets.map((target) => getAddress(target).toLowerCase()))
      .size !== suppliedTargets.length
  ) {
    throw new Error(
      "Kletia Intent Router V2 iç yetki hedefleri kanonik sırayla eşleşmiyor.",
    );
  }

  const systemIdentities = [
    authorities.router,
    authorities.adapter,
    authorities.target,
    authorities.factory,
    authorities.wrappedNative,
  ].map((value) => getAddress(value).toLowerCase());
  if (new Set(systemIdentities).size !== systemIdentities.length) {
    throw new Error(
      "Kletia Intent Router V2 sistem kimlikleri birbirinden ayrık değil.",
    );
  }
}

export function assertLaunchFactoryV2TransactionPlanBoundary(
  plan: NetworkTransactionPlan,
) {
  const isLaunchFactoryV2 = plan.executionMode === "kletia_launch_factory_v2";
  if (!isLaunchFactoryV2) {
    if (plan.launchFactoryV2Authority !== undefined) {
      throw new Error(
        "Launch Factory V2 yetkisi yalnız deploy_token işleminde kullanılabilir.",
      );
    }
    return;
  }

  const authority = plan.launchFactoryV2Authority;
  if (
    plan.network !== "base" ||
    plan.chainId !== BASE_MAINNET_CHAIN_ID ||
    plan.action.trim().toLowerCase() !== "deploy_token" ||
    getAddress(plan.to) !== BASE_LAUNCH_FACTORY_V2_ADDRESS ||
    !authority ||
    getAddress(authority.factory) !== BASE_LAUNCH_FACTORY_V2_ADDRESS ||
    authority.runtimeCodehash.toLowerCase() !==
      BASE_LAUNCH_FACTORY_V2_RUNTIME_CODEHASH.toLowerCase() ||
    !isAddress(authority.predictedAddress) ||
    !isAddress(authority.recipient) ||
    authority.totalSupply <= 0n ||
    authority.name.length === 0 ||
    authority.symbol.length === 0 ||
    !plan.userAddress ||
    getAddress(authority.recipient) !== getAddress(plan.userAddress) ||
    (plan.approvals?.length || 0) !== 0 ||
    plan.atomicRequired === true ||
    plan.requireEoa === true ||
    plan.simulationReturnPolicy !== undefined ||
    plan.intentV2Authorities !== undefined
  ) {
    throw new Error(
      "Kletia Launch Factory V2 işlem planı exact Base factory, CREATE2 adresi ve sıfır-approval politikasına bağlı değil.",
    );
  }
}

export function assertLaunchFactoryV2SimulationReturn(
  authority: NetworkTransactionPlan["launchFactoryV2Authority"],
  returnData: Hex | undefined,
) {
  if (!authority) return;
  if (!returnData || !/^0x[\da-fA-F]{64}$/.test(returnData)) {
    throw new Error(
      "Launch Factory V2 simülasyonu beklenen token adresini döndürmedi.",
    );
  }
  const [returnedAddress] = decodeAbiParameters(
    [{ type: "address" }],
    returnData,
  );
  if (getAddress(returnedAddress) !== getAddress(authority.predictedAddress)) {
    throw new Error(
      "Launch Factory V2 simülasyon çıktısı kanıtlanan CREATE2 adresiyle eşleşmiyor.",
    );
  }
}

export function assertTransactionReturnData(
  policy: NetworkTransactionPlan["simulationReturnPolicy"] | undefined,
  data: Hex | undefined,
) {
  if (policy === undefined) return;
  if (
    policy !== "uint256_zero" ||
    typeof data !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(data)
  ) {
    throw new Error(
      "Protokol simülasyonu gerekli uint256 durum kodunu döndürmedi.",
    );
  }
  const [returnCode] = decodeAbiParameters([{ type: "uint256" }], data);
  if (returnCode !== 0n) {
    throw new Error(
      `Protokol simülasyonu başarısız durum kodu döndürdü: ${returnCode}.`,
    );
  }
}

function assertSuccessfulReceipt(receipt: TransactionReceipt, label: string) {
  if (receipt.status !== "success") {
    throw new Error(`${label} zincirde başarısız oldu.`);
  }
}

export function useTransactionExecutor() {
  const { address, isConnected } = useAccount();
  const activeChainId = useChainId();
  const wagmiConfig = useConfig();
  const publicClient = usePublicClient();
  const { sendTransactionAsync } = useSendTransaction();
  const { sendCallsAsync } = useSendCalls();
  const { data: capabilities } = useCapabilities({ account: address });

  const scanAddress = useCallback(
    async (target: Address, network: NetworkMode, action?: string) => {
      const expectedNetwork = getNetwork(network);
      const normalizedAction = action?.trim().toLowerCase();
      if (
        action !== undefined &&
        !/^[a-z][a-z0-9_]{0,63}$/.test(normalizedAction || "")
      ) {
        throw new Error("Güvenlik taraması için geçerli bir action gerekli.");
      }
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 12_000);
      try {
        const requestUrl = new URL(
          `${BACKEND_URL}/api/webacy/scan/${target}`,
          window.location.origin,
        );
        requestUrl.searchParams.set("network", network);
        requestUrl.searchParams.set("chainId", String(expectedNetwork.chainId));
        if (normalizedAction) {
          requestUrl.searchParams.set("action", normalizedAction);
        }
        const response = await fetch(requestUrl.toString(), {
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            "X-Kletia-Network": network,
            "X-Kletia-Chain-Id": String(expectedNetwork.chainId),
          },
        });

        const result = await response.json().catch(() => null);
        if (!response.ok || result?.status !== "success") {
          throw new Error(
            result?.message ||
              "Güvenlik servisi işlemi doğrulayamadı. Güvenlik kontrolü olmadan işlem gönderilmedi.",
          );
        }

        const expectedSource =
          network === "arc" ? "arc_manifest+rpc_bytecode" : "webacy";
        if (
          result.network !== network ||
          result.chainId !== expectedNetwork.chainId ||
          result.source !== expectedSource ||
          !result.address ||
          getAddress(result.address) !== getAddress(target) ||
          result.isContract !== true
        ) {
          throw new Error(
            "Güvenlik servisi farklı bir ağ veya hedef için yanıt döndürdü.",
          );
        }
        if (
          normalizedAction &&
          (result.actionBound !== true ||
            result.action !== normalizedAction ||
            result.targetPolicy !==
              (network === "base" &&
              (normalizedAction === "x402_gateway_admin" ||
                normalizedAction === "x402_gateway_payment")
                ? "base_x402_factory_provenance"
                : "network_action_allowlist"))
        ) {
          throw new Error(
            "Güvenlik servisi hedefi işlem action alanına bağlamadı.",
          );
        }

        if (result.decision !== "approved" || result.approved === false) {
          throw new Error(
            result?.message ||
              "Güvenlik politikası bu adres için işlemi durdurdu.",
          );
        }

        if (
          network === "base" &&
          (!Number.isFinite(result.riskScore) ||
            result.riskScore > SECURITY_BLOCK_THRESHOLD)
        ) {
          const tags = Array.isArray(result.tags)
            ? ` (${result.tags.join(", ")})`
            : "";
          throw new Error(
            `Güvenlik kontrolü bu adresi yüksek riskli olarak işaretledi${tags}.`,
          );
        }
        if (
          network === "arc" &&
          (result.riskScore !== null ||
            result.allowlisted !== true ||
            result.bytecodeVerified !== true)
        ) {
          throw new Error(
            "Arc manifest veya RPC bytecode kanıtı eksik; işlem gönderilmedi.",
          );
        }

        return result;
      } catch (error) {
        if ((error as Error).name === "AbortError") {
          throw new Error(
            "Güvenlik servisi zaman aşımına uğradı. Kontrol tamamlanmadan işlem gönderilmedi.",
            { cause: error },
          );
        }
        throw error;
      } finally {
        window.clearTimeout(timeout);
      }
    },
    [],
  );

  const execute = useCallback(
    async (
      plan: NetworkTransactionPlan,
      onLog: LogHandler = () => undefined,
    ): Promise<TransactionExecutionResult> => {
      const expectedNetwork = getNetwork(plan.network);
      if (expectedNetwork.chainId !== plan.chainId) {
        throw new Error(
          "İşlem planındaki ağ adı ile chain ID birbiriyle eşleşmiyor.",
        );
      }
      const normalizedAction = plan.action?.trim().toLowerCase();
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(normalizedAction || "")) {
        throw new Error(
          "İşlem planı geçerli ve doğrulanabilir bir action taşımıyor.",
        );
      }
      assertIntentV2TransactionPlanBoundary(plan);
      assertLaunchFactoryV2TransactionPlanBoundary(plan);

      if (!isConnected || !address || !publicClient) {
        throw new Error("İşlem göndermek için cüzdanınızı bağlayın.");
      }

      const executionAddress = getAddress(address);
      const assertExecutionContext = () => {
        const currentAccount = getAccount(wagmiConfig);
        if (
          !currentAccount.isConnected ||
          !currentAccount.address ||
          getAddress(currentAccount.address) !== executionAddress ||
          currentAccount.chainId !== plan.chainId ||
          publicClient.chain?.id !== plan.chainId
        ) {
          throw new Error(
            `Cüzdan hesabı veya ağı işlem sırasında değişti. Beklenen chain ID: ${plan.chainId}.`,
          );
        }
        if (plan.expiresAt && Date.now() > plan.expiresAt) {
          throw new Error(
            "Bu işlem rotasının süresi doldu. Lütfen niyeti yeniden oluşturun.",
          );
        }
        if (
          plan.userAddress &&
          getAddress(plan.userAddress) !== executionAddress
        ) {
          throw new Error(
            "İşlem planı şu anda bağlı olan cüzdan için oluşturulmamış.",
          );
        }
      };
      assertExecutionContext();

      if (plan.requireEoa) {
        const accountCode = await publicClient.getCode({
          address: executionAddress,
        });
        if (accountCode && accountCode !== "0x") {
          throw new Error(
            "Bu Arc extension rotası original-sender semantiği nedeniyle yalnızca doğrudan EOA cüzdanla yürütülebilir.",
          );
        }
      }

      if (!isAddress(plan.to) || !/^0x[0-9a-fA-F]*$/.test(plan.data)) {
        throw new Error("Backend geçersiz hedef adres veya calldata döndürdü.");
      }

      const bytecode = await publicClient.getCode({ address: plan.to });
      if ((!bytecode || bytecode === "0x") && plan.data !== "0x") {
        throw new Error(
          "Calldata içeren işlem hedefi geçerli bir akıllı sözleşme değil.",
        );
      }
      if (
        plan.launchFactoryV2Authority &&
        (!bytecode ||
          bytecode === "0x" ||
          keccak256(bytecode).toLowerCase() !==
            plan.launchFactoryV2Authority.runtimeCodehash.toLowerCase())
      ) {
        throw new Error(
          "Launch Factory V2 canlı bytecode hash değeri niyet kanıtıyla eşleşmiyor.",
        );
      }

      onLog(`🛡️ ${plan.network.toUpperCase()} güvenlik kontrolü başlatıldı.`);
      await scanAddress(plan.to, plan.network, normalizedAction);
      assertExecutionContext();
      onLog("✅ Hedef adres güvenlik kontrolünden geçti.");

      const policyTargets = [
        ...new Set(
          (plan.policyTargets || []).map((target) =>
            getAddress(target).toLowerCase(),
          ),
        ),
      ];
      for (const policyTarget of policyTargets) {
        assertExecutionContext();
        await scanAddress(getAddress(policyTarget), plan.network);
      }
      if (policyTargets.length > 0) {
        onLog(`✅ ${policyTargets.length} iç politika hedefi ayrıca tarandı.`);
      }

      const approvalRequirements = new Map<string, TransactionApproval>();
      for (const approval of plan.approvals || []) {
        if (approval.amount < 0n) {
          throw new Error("Token approval miktarı negatif olamaz.");
        }
        if (approval.amount === 0n) continue;

        const normalizedApproval = {
          ...approval,
          token: getAddress(approval.token),
          spender: getAddress(approval.spender),
        };
        if (normalizedApproval.spender !== getAddress(plan.to)) {
          throw new Error(
            "Token allowance hedefi ana işlem hedefiyle eşleşmiyor.",
          );
        }

        const approvalKey =
          `${normalizedApproval.token.toLowerCase()}:` +
          normalizedApproval.spender.toLowerCase();
        const existingApproval = approvalRequirements.get(approvalKey);
        if (
          !existingApproval ||
          existingApproval.amount < normalizedApproval.amount
        ) {
          approvalRequirements.set(approvalKey, normalizedApproval);
        }
      }

      const missingApprovals: Array<{
        token: Address;
        data: Hex;
        gasEstimate: bigint;
        symbol?: string;
      }> = [];
      for (const approval of approvalRequirements.values()) {
        assertExecutionContext();
        await scanAddress(approval.token, plan.network);
        assertExecutionContext();
        const allowance = await publicClient.readContract({
          address: approval.token,
          abi: erc20Abi,
          functionName: "allowance",
          args: [executionAddress, approval.spender],
        });

        if (allowance >= approval.amount) {
          onLog(`✅ ${approval.symbol || "Token"} allowance yeterli.`);
          continue;
        }

        const approvalData = encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [approval.spender, approval.amount],
        });

        onLog(
          `🔬 ${approval.symbol || "Token"} approval simülasyonu çalıştırılıyor.`,
        );
        const approvalSimulation = await publicClient.simulateContract({
          account: executionAddress,
          address: approval.token,
          abi: erc20Abi,
          functionName: "approve",
          args: [approval.spender, approval.amount],
        });
        if (approvalSimulation.result !== true) {
          throw new Error(
            `${approval.symbol || "Token"} approval simülasyonu başarı döndürmedi.`,
          );
        }
        const approvalGas = await publicClient.estimateGas({
          account: executionAddress,
          to: approval.token,
          data: approvalData,
          value: 0n,
        });

        assertExecutionContext();
        missingApprovals.push({
          token: approval.token,
          data: approvalData,
          gasEstimate: approvalGas,
          symbol: approval.symbol,
        });
      }

      const actionCall = {
        to: plan.to,
        data: plan.data,
        value: plan.value,
      } as const;
      const atomicCalls = buildAtomicCallBatch(missingApprovals, actionCall);
      const walletExecutionCapabilities =
        resolveBaseWalletExecutionCapabilities(
          plan.network,
          plan.chainId,
          capabilities,
        );
      const canUseAtomicCalls = walletExecutionCapabilities.canUseAtomicCalls;
      const canUsePaymaster =
        BASE_PAYMASTER_ENABLED && walletExecutionCapabilities.canUsePaymaster;
      assertRequiredAtomicApprovalPath(
        plan.atomicRequired === true,
        missingApprovals.length,
        canUseAtomicCalls,
        "capability",
      );

      let useAtomicCalls = canUseAtomicCalls;
      let gasEstimate: bigint | undefined = undefined;
      if (missingApprovals.length > 0 && useAtomicCalls) {
        assertExecutionContext();
        onLog(
          `🔬 ${atomicCalls.length} çağrılık Base atomic paket birlikte simüle ediliyor.`,
        );
        try {
          const atomicSimulation = await publicClient.simulateCalls({
            account: executionAddress,
            calls: atomicCalls,
          });
          if (atomicSimulation.results.length !== atomicCalls.length) {
            throw new Error(
              "Atomic paket simülasyonu tüm çağrılar için sonuç döndürmedi.",
            );
          }

          const failedCallIndex = atomicSimulation.results.findIndex(
            (result) => result.status !== "success",
          );
          if (failedCallIndex !== -1) {
            const failedResult = atomicSimulation.results[failedCallIndex];
            throw new Error(
              `Atomic paket simülasyonunda ${failedCallIndex + 1}. çağrı başarısız oldu: ${
                failedResult?.status === "failure"
                  ? failedResult.error.message
                  : "bilinmeyen simülasyon hatası"
              }`,
            );
          }
          const actionSimulation =
            atomicSimulation.results[atomicCalls.length - 1];
          if (!actionSimulation || actionSimulation.status !== "success") {
            throw new Error(
              "Atomic paket ana işlem için doğrulanmış dönüş verisi üretmedi.",
            );
          }
          assertTransactionReturnData(
            plan.simulationReturnPolicy,
            actionSimulation.data,
          );
          gasEstimate = atomicSimulation.results.reduce(
            (total, result) => total + result.gasUsed,
            0n,
          );
          onLog(
            `✅ Atomic paket simülasyonu başarılı. Toplam tahmini gas: ${gasEstimate.toString()}.`,
          );
        } catch (error) {
          const errorText = [
            (error as { name?: unknown })?.name,
            (error as { message?: unknown })?.message,
            (error as { details?: unknown })?.details,
            (error as { cause?: { message?: unknown } })?.cause?.message,
          ]
            .filter((value): value is string => typeof value === "string")
            .join(" ")
            .toLowerCase();
          const simulationMethodUnavailable =
            errorText.includes("-32601") ||
            errorText.includes("methodnotfoundrpcerror") ||
            errorText.includes("methodnotsupportedrpcerror") ||
            errorText.includes("method not found") ||
            errorText.includes("method does not exist") ||
            (errorText.includes("eth_simulatev1") &&
              (errorText.includes("does not exist") ||
                errorText.includes("not available") ||
                errorText.includes("not supported")));
          if (!simulationMethodUnavailable) throw error;

          assertRequiredAtomicApprovalPath(
            plan.atomicRequired === true,
            missingApprovals.length,
            false,
            "simulation",
          );
          useAtomicCalls = false;
          onLog(
            "ℹ️ RPC atomic paket simülasyonunu desteklemiyor; güvenli sıralı fallback kullanılacak.",
          );
        }
      }

      if (!useAtomicCalls) {
        if (missingApprovals.length > 0 && plan.beforeSubmit) {
          assertExecutionContext();
          onLog(
            "🔁 Değişebilir alıcı kimliği approval imzasından önce yeniden doğrulanıyor.",
          );
          await plan.beforeSubmit();
          assertExecutionContext();
        }
        for (const approval of missingApprovals) {
          assertExecutionContext();
          const approvalHash = await sendTransactionAsync({
            chainId: plan.chainId,
            to: approval.token,
            data: approval.data,
            value: 0n,
            gas: (approval.gasEstimate * 120n) / 100n,
          });

          onLog(
            `⏳ ${approval.symbol || "Token"} approval gönderildi: ${approvalHash}`,
          );
          const approvalReceipt = await publicClient.waitForTransactionReceipt({
            hash: approvalHash,
            confirmations: 1,
          });
          assertSuccessfulReceipt(approvalReceipt, "Token approval");
          assertExecutionContext();
          onLog("✅ Token approval zincirde doğrulandı.");
        }
      }

      if (!useAtomicCalls || missingApprovals.length === 0) {
        assertExecutionContext();
        onLog("🔬 İmzalanacak son işlem eth_call ile simüle ediliyor.");
        const actionSimulation = await publicClient.call({
          account: executionAddress,
          ...actionCall,
        });
        assertTransactionReturnData(
          plan.simulationReturnPolicy,
          actionSimulation.data,
        );
        assertLaunchFactoryV2SimulationReturn(
          plan.launchFactoryV2Authority,
          actionSimulation.data,
        );
        gasEstimate = await publicClient.estimateGas({
          account: executionAddress,
          ...actionCall,
        });
        assertExecutionContext();
        onLog(
          `✅ Simülasyon başarılı. Tahmini gas: ${gasEstimate.toString()}.`,
        );
      }
      if (gasEstimate === undefined) {
        throw new Error("İşlem için doğrulanmış gas tahmini oluşturulamadı.");
      }

      if (plan.beforeSubmit) {
        assertExecutionContext();
        onLog(
          "🔁 Değişebilir alıcı kimliği ana işlem imzasından hemen önce yeniden doğrulanıyor.",
        );
        await plan.beforeSubmit();
        assertExecutionContext();
      }

      let hash: Hex;
      if (useAtomicCalls) {
        onLog(
          canUsePaymaster
            ? "⚡ Base atomic desteği ve bağımsız paymaster desteği doğrulandı; paket sponsorlu gönderiliyor."
            : "⚡ Base atomic desteği doğrulandı; paket tek onayla all-or-nothing gönderiliyor.",
        );
        assertExecutionContext();
        const callResult = await sendCallsAsync({
          account: executionAddress,
          chainId: NETWORKS.base.chainId,
          calls: atomicCalls,
          forceAtomic: true,
          experimental_fallback: false,
          ...(canUsePaymaster
            ? {
                capabilities: {
                  paymasterService: {
                    url:
                      `${BACKEND_URL}/api/paymaster/sponsor` +
                      `?network=base&chainId=${NETWORKS.base.chainId}`,
                  },
                },
              }
            : {}),
        });
        const callId =
          typeof callResult === "string" ? callResult : callResult.id;
        const callsStatus = await waitForCallsStatus(wagmiConfig, {
          id: callId,
          timeout: 120_000,
          throwOnFailure: true,
        });
        if (callsStatus.status !== "success") {
          throw new Error("Base atomic çağrı paketi başarılı duruma ulaşmadı.");
        }
        const transactionHashes = [
          ...new Set(
            (callsStatus.receipts || [])
              .map((receipt) => receipt.transactionHash)
              .filter((receiptHash): receiptHash is Hex =>
                Boolean(receiptHash),
              ),
          ),
        ];
        if (transactionHashes.length !== 1) {
          throw new Error(
            "Base atomic çağrı paketi tek bir doğrulanabilir transaction hash döndürmedi.",
          );
        }
        hash = transactionHashes[0];
      } else {
        assertExecutionContext();
        hash = await sendTransactionAsync({
          chainId: plan.chainId,
          to: plan.to,
          data: plan.data,
          value: plan.value,
          gas: (gasEstimate * 120n) / 100n,
        });
      }

      onLog(`⏳ İşlem zincire gönderildi: ${hash}`);
      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        confirmations: 1,
      });
      assertSuccessfulReceipt(receipt, "Ana işlem");
      onLog("✅ İşlem receipt durumu zincirde başarılı olarak doğrulandı.");
      if (plan.launchFactoryV2Authority) {
        const launchAuthority = plan.launchFactoryV2Authority;
        const createdCode = await publicClient.getCode({
          address: launchAuthority.predictedAddress,
        });
        if (!createdCode || createdCode === "0x") {
          throw new Error(
            "Launch receipt başarılı olsa da kanıtlanan CREATE2 adresinde token bytecode bulunamadı.",
          );
        }
        const [
          deployedSupply,
          recipientBalance,
          deployedDecimals,
          deployedName,
          deployedSymbol,
        ] = await Promise.all([
          publicClient.readContract({
            address: launchAuthority.predictedAddress,
            abi: erc20Abi,
            functionName: "totalSupply",
          }),
          publicClient.readContract({
            address: launchAuthority.predictedAddress,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [launchAuthority.recipient],
          }),
          publicClient.readContract({
            address: launchAuthority.predictedAddress,
            abi: erc20Abi,
            functionName: "decimals",
          }),
          publicClient.readContract({
            address: launchAuthority.predictedAddress,
            abi: erc20Abi,
            functionName: "name",
          }),
          publicClient.readContract({
            address: launchAuthority.predictedAddress,
            abi: erc20Abi,
            functionName: "symbol",
          }),
        ]);
        if (
          deployedSupply !== launchAuthority.totalSupply ||
          recipientBalance !== launchAuthority.totalSupply ||
          deployedDecimals !== 18 ||
          deployedName !== launchAuthority.name ||
          deployedSymbol !== launchAuthority.symbol
        ) {
          throw new Error(
            "Deploy edilen token metadata veya full-supply recipient post-state kanıtıyla eşleşmiyor.",
          );
        }
        onLog(
          `✅ Fixed-supply token ve tam recipient bakiyesi CREATE2 adresinde doğrulandı: ${launchAuthority.predictedAddress}`,
        );
      }

      return { hash, receipt, gasEstimate };
    },
    [
      address,
      isConnected,
      publicClient,
      capabilities,
      scanAddress,
      sendCallsAsync,
      sendTransactionAsync,
      wagmiConfig,
    ],
  );

  return {
    execute,
    scanAddress,
    activeChainId,
    address,
    isConnected,
  };
}
