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
} from "../../networks/base/config/launchFactoryV2";
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

export type WalletExecutionCapabilities = {
  canUseAtomicCalls: boolean;
  canUsePaymaster: boolean;
};

export function resolveWalletExecutionCapabilities(
  network: NetworkMode,
  chainId: number,
  capabilities: unknown,
): WalletExecutionCapabilities {
  const expectedChainId = getNetwork(network).chainId;
  if (chainId !== expectedChainId || !capabilities || typeof capabilities !== "object") {
    return {
      canUseAtomicCalls: false,
      canUsePaymaster: false,
    };
  }

  const targetCapabilities = (capabilities as Record<string, unknown>)[
    String(chainId)
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
    canUsePaymaster:
      network === "base" &&
      chainId === BASE_MAINNET_CHAIN_ID &&
      paymasterService?.supported === true,
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
      "Kletia Intent Router V2 transaction halted due to unavailable Base atomic package simulation. Sequential approval fallback was not used.",
    );
  }
  throw new Error(
    "Kletia Intent Router V2 must execute the swap with missing token approval in a single Base atomic package. No approvals were sent because the wallet did not verify atomic capability.",
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
        "Typed Base V2 authorities can only be used in Kletia Intent Router V2 transactions.",
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
      "Kletia Intent Router V2 transaction plan does not comply with Base swap, typed authority, and atomic approval policies.",
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
      "Kletia Intent Router V2 internal authority targets do not match in canonical order.",
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
      "Kletia Intent Router V2 system identities are not distinct.",
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
        "Launch Factory V2 authority can only be used in deploy_token transactions.",
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
      "Kletia Launch Factory V2 transaction plan is not bound to the exact Base factory, CREATE2 address, and zero-approval policy.",
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
      "Launch Factory V2 simulation did not return the expected token address.",
    );
  }
  const [returnedAddress] = decodeAbiParameters(
    [{ type: "address" }],
    returnData,
  );
  if (getAddress(returnedAddress) !== getAddress(authority.predictedAddress)) {
    throw new Error(
      "Launch Factory V2 simulation output does not match the proven CREATE2 address.",
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
      "Protocol simulation did not return the required uint256 status code.",
    );
  }
  const [returnCode] = decodeAbiParameters([{ type: "uint256" }], data);
  if (returnCode !== 0n) {
    throw new Error(
      `Protocol simulation returned failure status code: ${returnCode}.`,
    );
  }
}

function assertSuccessfulReceipt(receipt: TransactionReceipt, label: string) {
  if (receipt.status !== "success") {
    throw new Error(`${label} failed on-chain.`);
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
        throw new Error("A valid action is required for the security scan.");
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
              "Security service failed to verify the transaction. Transaction was not sent without security check.",
          );
        }

        const expectedSource = network === "arc"
          ? "arc_manifest+rpc_bytecode"
          : network === "arbitrum"
            ? "arbitrum_manifest+rpc_bytecode"
            : "webacy";
        if (
          result.network !== network ||
          result.chainId !== expectedNetwork.chainId ||
          result.source !== expectedSource ||
          !result.address ||
          getAddress(result.address) !== getAddress(target) ||
          (result.isContract !== true &&
            !(network === "arbitrum" && normalizedAction === "transfer"))
        ) {
          throw new Error(
            "Security service returned a response for a different network or target.",
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
            "Security service did not bind the target to the transaction action field.",
          );
        }

        if (result.decision !== "approved" || result.approved === false) {
          throw new Error(
            result?.message ||
              "Security policy blocked the transaction for this address.",
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
            `Security check flagged this address as high risk${tags}.`,
          );
        }
        if (
          network === "arc" &&
          (result.riskScore !== null ||
            result.allowlisted !== true ||
            result.bytecodeVerified !== true)
        ) {
          throw new Error(
            "Arc manifest or RPC bytecode proof is missing; transaction was not sent.",
          );
        }
        if (
          network === "arbitrum" &&
          (result.riskScore !== null ||
            result.allowlisted !== true ||
            (result.bytecodeVerified !== true && normalizedAction !== "transfer"))
        ) {
          throw new Error(
            "Arbitrum reviewed manifest or recipient binding proof is missing; transaction was not sent.",
          );
        }

        return result;
      } catch (error) {
        if ((error as Error).name === "AbortError") {
          throw new Error(
            "Security service timed out. Transaction was not sent before verification completed.",
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
          "Network name and chain ID in the transaction plan do not match.",
        );
      }
      const normalizedAction = plan.action?.trim().toLowerCase();
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(normalizedAction || "")) {
        throw new Error(
          "Transaction plan does not contain a valid and verifiable action.",
        );
      }
      assertIntentV2TransactionPlanBoundary(plan);
      assertLaunchFactoryV2TransactionPlanBoundary(plan);

      if (!isConnected || !address || !publicClient) {
        throw new Error("Connect your wallet to send the transaction.");
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
            `Wallet account or network changed during the operation. Expected chain ID: ${plan.chainId}.`,
          );
        }
        if (plan.expiresAt && Date.now() > plan.expiresAt) {
          throw new Error(
            "This transaction route has expired. Please recreate the intent.",
          );
        }
        if (
          plan.userAddress &&
          getAddress(plan.userAddress) !== executionAddress
        ) {
          throw new Error(
            "Transaction plan was not created for the currently connected wallet.",
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
            "This Arc extension route can only be executed with a direct EOA wallet due to original-sender semantics.",
          );
        }
      }

      if (!isAddress(plan.to) || !/^0x[0-9a-fA-F]*$/.test(plan.data)) {
        throw new Error("Backend returned an invalid target address or calldata.");
      }

      const bytecode = await publicClient.getCode({ address: plan.to });
      if ((!bytecode || bytecode === "0x") && plan.data !== "0x") {
        throw new Error(
          "The transaction target with calldata is not a valid smart contract.",
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
          "Launch Factory V2 live bytecode hash does not match the intent proof.",
        );
      }

      onLog(`🛡️ ${plan.network.toUpperCase()} security check initiated.`);
      await scanAddress(plan.to, plan.network, normalizedAction);
      assertExecutionContext();
      onLog("✅ Target address passed the security check.");

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
        onLog(`✅ ${policyTargets.length} internal policy target also scanned.`);
      }

      const approvalRequirements = new Map<string, TransactionApproval>();
      for (const approval of plan.approvals || []) {
        if (approval.amount < 0n) {
          throw new Error("Token approval amount cannot be negative.");
        }
        if (approval.amount === 0n) continue;

        const normalizedApproval = {
          ...approval,
          token: getAddress(approval.token),
          spender: getAddress(approval.spender),
        };
        if (normalizedApproval.spender !== getAddress(plan.to)) {
          throw new Error(
            "Token allowance target does not match the main transaction target.",
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
          onLog(`✅ ${approval.symbol || "Token"} allowance is sufficient.`);
          continue;
        }

        const approvalData = encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [approval.spender, approval.amount],
        });

        onLog(
          `🔬 Running ${approval.symbol || "Token"} approval simulation.`,
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
            `${approval.symbol || "Token"} approval simulation did not return success.`,
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
        resolveWalletExecutionCapabilities(
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
          `🔬 Simulating ${atomicCalls.length} calls together as an atomic wallet package.`,
        );
        try {
          const atomicSimulation = await publicClient.simulateCalls({
            account: executionAddress,
            calls: atomicCalls,
          });
          if (atomicSimulation.results.length !== atomicCalls.length) {
            throw new Error(
              "Atomic batch simulation did not return results for all calls.",
            );
          }

          const failedCallIndex = atomicSimulation.results.findIndex(
            (result) => result.status !== "success",
          );
          if (failedCallIndex !== -1) {
            const failedResult = atomicSimulation.results[failedCallIndex];
            throw new Error(
              `Call ${failedCallIndex + 1} failed during atomic package simulation: ${
                failedResult?.status === "failure"
                  ? failedResult.error.message
                  : "unknown simulation error"
              }`,
            );
          }
          const actionSimulation =
            atomicSimulation.results[atomicCalls.length - 1];
          if (!actionSimulation || actionSimulation.status !== "success") {
            throw new Error(
              "Atomic batch did not produce verified return data for the main transaction.",
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
            `✅ Atomic package simulation successful. Total estimated gas: ${gasEstimate.toString()}.`,
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
            "ℹ️ RPC does not support atomic batch simulation; safe sequential fallback will be used.",
          );
        }
      }

      if (!useAtomicCalls) {
        if (missingApprovals.length > 0 && plan.beforeSubmit) {
          assertExecutionContext();
          onLog(
            "🔁 Mutable recipient identity is re-verified before approval signature.",
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
            `⏳ ${approval.symbol || "Token"} approval sent: ${approvalHash}`,
          );
          const approvalReceipt = await publicClient.waitForTransactionReceipt({
            hash: approvalHash,
            confirmations: 1,
          });
          assertSuccessfulReceipt(approvalReceipt, "Token approval");
          assertExecutionContext();
          onLog("✅ Token approval verified on-chain.");
        }
      }

      if (!useAtomicCalls || missingApprovals.length === 0) {
        assertExecutionContext();
        onLog("🔬 Simulating the final transaction to be signed with eth_call.");
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
          `✅ Simulation successful. Estimated gas: ${gasEstimate.toString()}.`,
        );
      }
      if (gasEstimate === undefined) {
        throw new Error("Verified gas estimate could not be generated for the transaction.");
      }

      if (plan.beforeSubmit) {
        assertExecutionContext();
        onLog(
          "🔁 Mutable recipient identity is re-verified immediately before the main transaction signature.",
        );
        await plan.beforeSubmit();
        assertExecutionContext();
      }

      let hash: Hex;
      if (useAtomicCalls) {
        const networkLabel = getNetwork(plan.network).name;
        onLog(
          canUsePaymaster
            ? `⚡ ${networkLabel} atomic support and independent paymaster support verified; batch is sent as sponsored.`
            : `⚡ ${networkLabel} atomic support verified; batch is sent as all-or-nothing with a single approval.`,
        );
        assertExecutionContext();
        const callResult = await sendCallsAsync({
          account: executionAddress,
          chainId: plan.chainId,
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
          throw new Error(`${networkLabel} atomic call batch did not reach a successful state.`);
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
            `${networkLabel} atomic call batch did not return a single verifiable transaction hash.`,
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

      onLog(`⏳ Transaction sent to chain: ${hash}`);
      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        confirmations: 1,
      });
      assertSuccessfulReceipt(receipt, "Main transaction");
      onLog("✅ Transaction receipt status successfully confirmed on-chain.");
      if (plan.launchFactoryV2Authority) {
        const launchAuthority = plan.launchFactoryV2Authority;
        const createdCode = await publicClient.getCode({
          address: launchAuthority.predictedAddress,
        });
        if (!createdCode || createdCode === "0x") {
          throw new Error(
            "Launch receipt succeeded but no token bytecode found at the proven CREATE2 address.",
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
            "Deployed token metadata or full-supply recipient post-state proof does not match.",
          );
        }
        onLog(
          `✅ Fixed-supply token and full recipient balance verified at CREATE2 address: ${launchAuthority.predictedAddress}`,
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
