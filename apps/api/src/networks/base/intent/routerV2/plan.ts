/**
 * Builds a Base Intent Router V2 swap plan.
 */
import { encodeFunctionData, keccak256 } from "viem";
import {
  ERC20_EXACT_APPROVAL_ABI,
  KLETIA_INTENT_ROUTER_V2_ABI,
} from "../routerV2Abis.js";
import {
  BASE_MAINNET_CHAIN_ID,
  BPS_DENOMINATOR,
  NATIVE_TOKEN_SENTINEL,
} from "./constants.js";
import type {
  BaseIntentV2SwapPlan,
  BuildBaseIntentV2SwapPlanInput,
} from "./types.js";
import {
  checkedRouteAddress,
  checkedRouteUint,
  routeError,
  sameAddress,
} from "./config.js";
import {
  checkedFeePolicy,
  checkedIntentTimes,
  requireIntentV2Config,
  validateRouteShape,
} from "./routes.js";

export function buildBaseIntentV2SwapPlan(
  input: BuildBaseIntentV2SwapPlanInput,
): BaseIntentV2SwapPlan {
  const config = requireIntentV2Config(input.executionConfig);
  const checked = validateRouteShape(input.route, config.deployment);
  const owner = checkedRouteAddress(input.owner);
  const recipient = checkedRouteAddress(input.recipient);
  const executor = checkedRouteAddress(input.executor, true);
  if (executor !== NATIVE_TOKEN_SENTINEL && !sameAddress(executor, owner)) {
    routeError();
  }
  const forbiddenRecipients = [
    config.router,
    config.deployment.wrappedNative,
    checked.adapter.adapter,
    checked.adapter.target,
    checked.adapter.spender,
    checked.normalizedTokenIn,
    checked.normalizedTokenOut,
  ];
  if (forbiddenRecipients.some((address) => sameAddress(address, recipient))) {
    routeError();
  }
  const times = checkedIntentTimes(input);
  const maxFeeBps = checkedFeePolicy(input.maxFeeBps, config.deployment.feeBps);

  const grossMinimumAfterSlippage =
    (checked.route.quotedAmountOut *
      (BPS_DENOMINATOR - BigInt(checked.route.slippageBps))) /
    BPS_DENOMINATOR;
  const estimatedFeeAtObservedRate =
    (grossMinimumAfterSlippage * BigInt(config.deployment.feeBps)) /
    BPS_DENOMINATOR;
  const maximumFeeAtSignedCap =
    (grossMinimumAfterSlippage * BigInt(maxFeeBps)) / BPS_DENOMINATOR;
  const quoteDerivedNetMinimum =
    grossMinimumAfterSlippage - maximumFeeAtSignedCap;
  let userMinimumNetAmountOut: bigint | null = null;
  if (input.minimumNetAmountOut !== undefined) {
    userMinimumNetAmountOut = checkedRouteUint(input.minimumNetAmountOut);
    if (userMinimumNetAmountOut === 0n) routeError();

    const maximumQuotedNetAfterSignedFeeCap =
      checked.route.quotedAmountOut -
      (checked.route.quotedAmountOut * BigInt(maxFeeBps)) / BPS_DENOMINATOR;
    if (userMinimumNetAmountOut > maximumQuotedNetAfterSignedFeeCap) {
      routeError();
    }
  }
  const netMinimumAmountOut =
    userMinimumNetAmountOut !== null &&
    userMinimumNetAmountOut > quoteDerivedNetMinimum
      ? userMinimumNetAmountOut
      : quoteDerivedNetMinimum;
  if (grossMinimumAfterSlippage === 0n || netMinimumAmountOut === 0n) {
    routeError();
  }

  const adapterData = checked.adapterData;
  const adapterDataHash = keccak256(adapterData);
  const contractIntent = {
    owner,
    tokenIn: checked.route.tokenIn,
    tokenOut: checked.route.tokenOut,
    amountIn: checked.route.amountIn,
    minAmountOut: netMinimumAmountOut,
    recipient,
    adapter: checked.adapter.adapter,
    adapterConfigHash: checked.adapter.adapterConfigHash,
    adapterDataHash,
    nonce: times.nonce,
    issuedAt: Number(times.issuedAt),
    validAfter: Number(times.validAfter),
    deadline: Number(times.deadline),
    executor,
    maxFeeBps,
  } as const;
  const calldata = encodeFunctionData({
    abi: KLETIA_INTENT_ROUTER_V2_ABI,
    functionName: "executeSwap",
    args: [contractIntent, adapterData],
  });
  const isNativeInput = checked.route.tokenIn === NATIVE_TOKEN_SENTINEL;
  const approvals = isNativeInput
    ? []
    : [
        {
          token: checked.route.tokenIn,
          spender: config.router,
          amount: checked.route.amountIn.toString(),
          calldata: encodeFunctionData({
            abi: ERC20_EXACT_APPROVAL_ABI,
            functionName: "approve",
            args: [config.router, checked.route.amountIn],
          }),
          required: true as const,
        },
      ];

  return {
    chainId: BASE_MAINNET_CHAIN_ID,
    executionMode: "kletia_intent_router_v2",
    targetContract: config.router,
    router: config.router,
    adapter: checked.adapter.adapter,
    adapterKind: checked.adapter.kind,
    adapterDataEncoding: checked.adapterDataEncoding,
    underlyingTarget: checked.adapter.target,
    underlyingSpender: checked.adapter.spender,
    underlyingFactory: checked.adapter.factory,
    wrappedNative: config.deployment.wrappedNative,
    calldata,
    value: isNativeInput ? checked.route.amountIn.toString() : "0",
    adapterData,
    intent: {
      owner,
      tokenIn: checked.route.tokenIn,
      tokenOut: checked.route.tokenOut,
      amountIn: checked.route.amountIn.toString(),
      minAmountOut: netMinimumAmountOut.toString(),
      recipient,
      adapter: checked.adapter.adapter,
      adapterConfigHash: checked.adapter.adapterConfigHash,
      adapterDataHash,
      nonce: times.nonce.toString(),
      issuedAt: times.issuedAt.toString(),
      validAfter: times.validAfter.toString(),
      deadline: times.deadline.toString(),
      executor,
      maxFeeBps,
    },
    approvals,
    policyTargets: [
      ...new Map(
        [
          checked.adapter.adapter,
          checked.adapter.target,
          checked.adapter.spender,
          checked.adapter.factory,
          config.deployment.wrappedNative,
        ].map((address) => [address.toLowerCase(), address]),
      ).values(),
    ],
    economics: {
      quotedGrossAmountOut: checked.route.quotedAmountOut.toString(),
      grossMinimumAfterSlippage: grossMinimumAfterSlippage.toString(),
      estimatedFeeAtObservedRate: estimatedFeeAtObservedRate.toString(),
      maximumFeeAtSignedCap: maximumFeeAtSignedCap.toString(),
      netMinimumAmountOut: netMinimumAmountOut.toString(),
      userMinimumNetAmountOut: userMinimumNetAmountOut?.toString() ?? null,
      bindingMinimumSource:
        userMinimumNetAmountOut !== null &&
        userMinimumNetAmountOut > quoteDerivedNetMinimum
          ? "user_minimum"
          : "slippage_and_fee_cap",
      observedFeeBps: config.deployment.feeBps,
      maxFeeBps,
      slippageBps: checked.route.slippageBps,
    },
    configEvidence: {
      schemaVersion: config.deployment.schemaVersion,
      adapterKind: checked.adapter.kind,
      observedAtBlock: config.deployment.observedAtBlock.toString(),
      routerCodehash: config.deployment.routerCodehash,
      wrappedNativeCodehash: config.deployment.wrappedNativeCodehash,
      adapterConfigHash: checked.adapter.adapterConfigHash,
      adapterConfigurationHash: checked.adapter.adapterConfigurationHash,
    },
  };
}
