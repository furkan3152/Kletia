import React, { useState, useEffect, useCallback } from 'react';
import { Wallet, Settings, ExternalLink, RefreshCw, Copy, Plus, CheckCircle, ArrowDownToLine, DollarSign, Cpu, AlertTriangle, Zap, Info, Shield } from 'lucide-react';
import {
  useAccount,
  useChainId,
  useConfig,
  usePublicClient,
  useReadContract,
  useWalletClient,
} from 'wagmi';
import { getAccount } from '@wagmi/core';
import { useSecureWriteContract } from '../../hooks/useSecureTransaction';
import {
  decodeEventLog,
  formatUnits,
  getAddress,
  isAddress,
  parseAbiItem,
  parseUnits,
  type Address,
  type Hex,
  type TransactionReceipt,
} from 'viem';
import { useTransactionExecutor } from '../../hooks/useTransactionExecutor';
import {
  decodePaymentResponseHeader,
  x402Client,
  x402HTTPClient,
  type PaymentRequirements,
} from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { X402FactoryABI, X402GatewayABI, USDC_ADDRESS, X402_FACTORY_ADDRESS } from '../../contracts/X402';
import { NETWORKS } from '../../config/networks';
import { BACKEND_URL } from '../../config/runtime';

interface ContractData {
  address: string;
  owner: string;
  price: string;
  collected: string;
  label: string;
}

interface X402DebugInfo {
  status: number;
  payTo: string;
  price: string;
  network: string;
  error?: string;
}

interface VerifiedPaymentEvidence {
  network: typeof BASE_CAIP_NETWORK;
  payer: Address;
  amountAtomic: string;
  amount: string;
  evidence: 'base_receipt';
  transaction?: Hex;
  blockNumber?: string;
  finality: 'base_inclusion';
}

interface X402PayResult {
  error?: boolean;
  message?: string;
  status?: number;
  payment?: VerifiedPaymentEvidence;
  data?: unknown;
}

interface X402Policy {
  maxGatewayPriceAtomic: bigint;
}

interface ExactTypedDataRequest {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
}

const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const errorMessage = (error: unknown, fallback: string): string => {
  if (!(error instanceof Error)) return fallback;

  const sanitized = error.message
    .replace(/https?:\/\/[^\s"'<>]+/giu, '[redacted-url]')
    .replace(
      /\b(?:authorization|x-payment|payment-signature|signature|api[-_ ]?key)\b\s*[:=]\s*[^\s,;]+/giu,
      '[redacted-credential]',
    )
    .replace(/\b0x[a-f\d]{96,}\b/giu, '[redacted-payload]')
    .replace(/\b[A-Za-z\d+/_-]{80,}={0,2}\b/gu, '[redacted-payload]')
    .trim();

  return sanitized || fallback;
};

// ── ERC20 ABI for USDC balance ─────────────────────────────────────────
const ERC20_BALANCE_ABI = [
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function'
  }
] as const;
const ERC20_TRANSFER_EVENT_ABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: 'from', type: 'address' },
      { indexed: true, name: 'to', type: 'address' },
      { indexed: false, name: 'value', type: 'uint256' },
    ],
    name: 'Transfer',
    type: 'event',
  },
] as const;
const GATEWAY_CREATED_EVENT = parseAbiItem(
  'event GatewayCreated(address indexed gatewayAddress, address indexed owner, address usdc, uint256 initialPrice)',
);

const BASE_CHAIN_ID = NETWORKS.base.chainId;
const BASE_CAIP_NETWORK = `eip155:${BASE_CHAIN_ID}` as const;
const X402_PROTOCOL_VERSION = 2;
const MAX_PAYMENT_TIMEOUT_SECONDS = 300;
const FETCH_TIMEOUT_MS = 15_000;
const X402_FACTORY_DEPLOYMENT_BLOCK = 48_037_476n;

const assertReceiptSuccess = (receipt: TransactionReceipt) => {
  if (receipt.status !== 'success') {
    throw new Error('Base transaction was included but reverted.');
  }
};

const parseUsdcPrice = (
  value: string,
  label: string,
  maxAmount?: bigint,
) => {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value.trim())) {
    throw new Error(`${label} must be a positive USDC amount with at most 6 decimals.`);
  }
  const atomic = parseUnits(value.trim(), NETWORKS.base.tokens.usdc.decimals);
  if (atomic <= 0n) {
    throw new Error(`${label} must be greater than zero.`);
  }
  if (maxAmount !== undefined && atomic > maxAmount) {
    throw new Error(
      `${label} exceeds the server gateway-demo price policy (${formatUnits(maxAmount, NETWORKS.base.tokens.usdc.decimals)} USDC).`,
    );
  }
  return atomic;
};

const requestWithTimeout = async (
  input: RequestInfo | URL,
  init?: RequestInit,
) => {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await window.fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      throw new Error(
        'x402 endpoint timed out; no unchecked payment was sent.',
        { cause: error },
      );
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
};

const normalizeRequiredAddress = (value: string, label: string) => {
  if (!isAddress(value)) {
    throw new Error(`x402 ${label} is not a valid EVM address.`);
  }
  return getAddress(value);
};

const validatePaymentRequirement = (
  requirement: PaymentRequirements,
  expectedGateway: Address,
  expectedAmount: bigint,
) => {
  if (requirement.scheme !== 'exact') {
    throw new Error(`Unsupported x402 scheme: ${requirement.scheme}.`);
  }
  if (requirement.network !== BASE_CAIP_NETWORK) {
    throw new Error(`x402 requested ${requirement.network}, not Base Mainnet.`);
  }
  if (
    normalizeRequiredAddress(requirement.asset, 'asset') !==
    getAddress(USDC_ADDRESS)
  ) {
    throw new Error('x402 requested an asset other than Base Mainnet USDC.');
  }
  if (
    normalizeRequiredAddress(requirement.payTo, 'payTo') !== expectedGateway
  ) {
    throw new Error('x402 payTo does not match the active gateway.');
  }
  if (!/^(?:0|[1-9]\d*)$/.test(requirement.amount)) {
    throw new Error('x402 amount is not an unsigned atomic USDC amount.');
  }
  if (BigInt(requirement.amount) !== expectedAmount) {
    throw new Error(
      'x402 amount does not exactly match the gateway on-chain price.',
    );
  }
  if (
    !Number.isInteger(requirement.maxTimeoutSeconds) ||
    requirement.maxTimeoutSeconds <= 0 ||
    requirement.maxTimeoutSeconds > MAX_PAYMENT_TIMEOUT_SECONDS
  ) {
    throw new Error('x402 authorization timeout exceeds the client policy.');
  }

  const extra = requirement.extra || {};
  if (
    extra.name !== 'USD Coin' ||
    extra.version !== '2' ||
    (extra.assetTransferMethod !== undefined &&
      extra.assetTransferMethod !== 'eip3009')
  ) {
    throw new Error('x402 Base USDC authorization domain is not approved.');
  }

  return requirement;
};

const validateExactAuthorization = (
  params: ExactTypedDataRequest,
  expectedAccount: Address,
  expectedGateway: Address,
  expectedAmount: bigint,
) => {
  const domain = params.domain;
  const message = params.message;
  const transferFields = params.types.TransferWithAuthorization;
  if (
    params.primaryType !== 'TransferWithAuthorization' ||
    domain.name !== 'USD Coin' ||
    domain.version !== '2' ||
    Number(domain.chainId) !== BASE_CHAIN_ID ||
    normalizeRequiredAddress(
      String(domain.verifyingContract || ''),
      'verifyingContract',
    ) !== getAddress(USDC_ADDRESS) ||
    !Array.isArray(transferFields) ||
    transferFields.map((field) =>
      isRecord(field) ? `${field.name}:${field.type}` : '',
    ).join(',') !==
      'from:address,to:address,value:uint256,validAfter:uint256,validBefore:uint256,nonce:bytes32' ||
    normalizeRequiredAddress(String(message.from || ''), 'from') !==
      expectedAccount ||
    normalizeRequiredAddress(String(message.to || ''), 'to') !==
      expectedGateway ||
    BigInt(String(message.value)) !== expectedAmount
  ) {
    throw new Error('x402 requested an unexpected EIP-3009 authorization.');
  }

  const now = BigInt(Math.floor(Date.now() / 1000));
  const validAfter = BigInt(String(message.validAfter));
  const validBefore = BigInt(String(message.validBefore));
  const nonce = String(message.nonce || '');
  if (
    validAfter > now ||
    validBefore <= now ||
    validBefore > now + BigInt(MAX_PAYMENT_TIMEOUT_SECONDS + 30) ||
    !/^0x[0-9a-fA-F]{64}$/.test(nonce)
  ) {
    throw new Error('x402 EIP-3009 authorization window or nonce is invalid.');
  }

  return {
    domain: {
      name: 'USD Coin',
      version: '2',
      chainId: BASE_CHAIN_ID,
      verifyingContract: getAddress(USDC_ADDRESS),
    },
    message: {
      from: expectedAccount,
      to: expectedGateway,
      value: expectedAmount,
      validAfter,
      validBefore,
      nonce: nonce as Hex,
    },
  };
};

export const X402ConsoleWidget: React.FC = () => {

  const [contractLabel, setContractLabel] = useState('My x402 Gateway');
  const [initialPrice, setInitialPrice] = useState('0.01');
  const [activeContract, setActiveContract] = useState<ContractData | null>(null);
  const [isDeploying, setIsDeploying] = useState(false);
  const [isTestingPay, setIsTestingPay] = useState(false);
  const [newPrice, setNewPrice] = useState('0.01');
  const [loadAddress, setLoadAddress] = useState('');
  const [statusLog, setStatusLog] = useState<string[]>([]);
  const [debugInfo, setDebugInfo] = useState<X402DebugInfo | null>(null);
  const [payResult, setPayResult] = useState<X402PayResult | null>(null);
  const [policy, setPolicy] = useState<X402Policy | null>(null);
  const [policyError, setPolicyError] = useState<string | null>(null);

  const { address } = useAccount();
  const chainId = useChainId();
  const wagmiConfig = useConfig();
  const { writeContractAsync, isCheckingSecurity, securityError, clearSecurityError } = useSecureWriteContract();
  const { scanAddress } = useTransactionExecutor();
  const publicClient = usePublicClient({ chainId: BASE_CHAIN_ID });
  const { data: walletClient } = useWalletClient();

  // ── Read on-chain data ─────────────────────────────────────────────────
  const { data: onChainPrice, refetch: refetchPrice } = useReadContract({
    address: activeContract?.address as `0x${string}`,
    abi: X402GatewayABI,
    functionName: 'pricePerCall',
    chainId: BASE_CHAIN_ID,
    query: { enabled: !!activeContract },
  });

  const { data: gatewayUsdcBalance, refetch: refetchBalance } = useReadContract({
    address: USDC_ADDRESS as `0x${string}`,
    abi: ERC20_BALANCE_ABI,
    functionName: 'balanceOf',
    args: activeContract ? [activeContract.address as `0x${string}`] : undefined,
    chainId: BASE_CHAIN_ID,
    query: { enabled: !!activeContract },
  });
  const displayedContractPrice =
    activeContract && onChainPrice !== undefined
      ? formatUnits(onChainPrice, NETWORKS.base.tokens.usdc.decimals)
      : activeContract?.price;
  const displayedContractBalance =
    activeContract && gatewayUsdcBalance !== undefined
      ? formatUnits(
          gatewayUsdcBalance,
          NETWORKS.base.tokens.usdc.decimals,
        )
      : activeContract?.collected;

  useEffect(() => {
    let active = true;
    const loadPolicy = async () => {
      try {
        const response = await requestWithTimeout(
          `${BACKEND_URL}/api/premium/x402-config`,
          {
            headers: {
              Accept: 'application/json',
              'X-Kletia-Network': 'base',
              'X-Kletia-Chain-Id': String(BASE_CHAIN_ID),
            },
          },
        );
        const payload = await response.json();
        const data = payload?.data;
        if (
          !response.ok ||
          payload?.status !== 'success' ||
          data?.network !== BASE_CAIP_NETWORK ||
          data?.scheme !== 'exact' ||
          !isAddress(data?.usdc) ||
          getAddress(data.usdc) !== getAddress(USDC_ADDRESS) ||
          !isAddress(data?.gatewayFactory) ||
          getAddress(data.gatewayFactory) !== getAddress(X402_FACTORY_ADDRESS) ||
          !/^(?:0|[1-9]\d*)$/.test(
            String(data?.maxGatewayDemoPriceAtomic || ''),
          )
        ) {
          throw new Error('Backend returned an invalid x402 policy.');
        }
        const maxGatewayPriceAtomic = BigInt(
          data.maxGatewayDemoPriceAtomic,
        );
        if (maxGatewayPriceAtomic <= 0n) {
          throw new Error('Backend x402 price policy is not positive.');
        }
        if (active) {
          setPolicy({ maxGatewayPriceAtomic });
          setPolicyError(null);
        }
      } catch (error) {
        if (active) {
          setPolicy(null);
          setPolicyError(
            errorMessage(error, 'x402 policy is unavailable.'),
          );
        }
      }
    };
    void loadPolicy();
    return () => {
      active = false;
    };
  }, []);

  // ── Logger ─────────────────────────────────────────────────────────────
  const log = useCallback((msg: string) => {
    setStatusLog(prev => [...prev.slice(-19), `[${new Date().toLocaleTimeString()}] ${msg}`]);
  }, []);

  const assertBaseWalletContext = useCallback(
    (expectedAccount: Address) => {
      const current = getAccount(wagmiConfig);
      if (
        !current.isConnected ||
        !current.address ||
        getAddress(current.address) !== expectedAccount ||
        current.chainId !== BASE_CHAIN_ID ||
        chainId !== BASE_CHAIN_ID ||
        walletClient?.chain?.id !== BASE_CHAIN_ID ||
        walletClient.account?.address === undefined ||
        getAddress(walletClient.account.address) !== expectedAccount ||
        publicClient?.chain?.id !== BASE_CHAIN_ID
      ) {
        throw new Error(
          'Wallet account or chain changed during the x402 flow; authorization stopped.',
        );
      }
    },
    [chainId, publicClient, wagmiConfig, walletClient],
  );

  const assertGatewayPrice = useCallback(
    async (gateway: Address, expectedAmount: bigint) => {
      if (!publicClient) {
        throw new Error('Base public client is unavailable.');
      }
      const currentPrice = await publicClient.readContract({
        address: gateway,
        abi: X402GatewayABI,
        functionName: 'pricePerCall',
      });
      if (currentPrice !== expectedAmount || currentPrice <= 0n) {
        throw new Error(
          'Gateway price changed during authorization; payment was not sent.',
        );
      }
    },
    [publicClient],
  );

  const handleDeploy = async () => {
    if (!address) return alert("Connect your wallet first.");
    if (!policy) {
      return alert(
        policyError || 'The backend x402 safety policy is unavailable.',
      );
    }
    if (chainId !== BASE_CHAIN_ID) {
      return alert(`Switch your wallet to Base Mainnet (${BASE_CHAIN_ID}).`);
    }
    setIsDeploying(true);
    log("🚀 Deploying gateway contract...");

    try {
      const priceAtomic = parseUsdcPrice(
        initialPrice,
        'Initial price',
        policy.maxGatewayPriceAtomic,
      );

      const txHash = await writeContractAsync({
        securityAction: 'x402_factory_create',
        address: X402_FACTORY_ADDRESS as `0x${string}`,
        abi: X402FactoryABI,
        functionName: 'createGateway',
        args: [USDC_ADDRESS, priceAtomic],
        chainId: BASE_CHAIN_ID,
      });

      log(`📤 TX sent: ${txHash.substring(0, 16)}...`);

      if (publicClient) {
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
        assertReceiptSuccess(receipt);
        log(
          `✅ Base receipt succeeded in block ${receipt.blockNumber}. Inclusion is confirmed; L1 finality is not asserted.`,
        );

        let deployedGateway = "";
        for (const logEntry of receipt.logs) {
          if (
            getAddress(logEntry.address) !== getAddress(X402_FACTORY_ADDRESS)
          ) {
            continue;
          }
          try {
            const decoded = decodeEventLog({
              abi: X402FactoryABI,
              data: logEntry.data,
              topics: logEntry.topics,
            });
            if (decoded.eventName === 'GatewayCreated') {
              deployedGateway = decoded.args.gatewayAddress;
              break;
            }
          } catch { /* skip non-matching logs */ }
        }

        if (deployedGateway) {
          const newContract: ContractData = {
            address: deployedGateway,
            owner: address,
            price: initialPrice,
            collected: '0',
            label: contractLabel
          };
          setActiveContract(newContract);
          log(`🎉 Gateway deployed: ${deployedGateway.substring(0, 10)}...`);
        } else {
          log("⚠️ Contract created but address could not be read from event.");
        }
      }
    } catch (error) {
      log(
        `❌ Deploy error: ${errorMessage(
          error,
          'Unknown deployment error.',
        ).substring(0, 100)}`,
      );
    }
    setIsDeploying(false);
  };

  // ── Load Existing Contract ─────────────────────────────────────────────
  const handleLoadContract = async () => {
    if (!isAddress(loadAddress)) {
      return alert("Enter a valid contract address.");
    }
    if (!policy) {
      return alert(
        policyError || 'The backend x402 safety policy is unavailable.',
      );
    }

    const gateway = getAddress(loadAddress);
    log(`🔄 Loading contract: ${gateway.substring(0, 10)}...`);

    try {
      if (publicClient) {
        const code = await publicClient.getCode({ address: gateway });
        if (!code || code === '0x') {
          throw new Error('Address has no contract bytecode on Base Mainnet.');
        }

        const [price, owner, gatewayUsdc, balance, factoryLogs] = await Promise.all([
          publicClient.readContract({
            address: gateway,
            abi: X402GatewayABI,
            functionName: 'pricePerCall',
          }),
          publicClient.readContract({
            address: gateway,
            abi: X402GatewayABI,
            functionName: 'owner',
          }),
          publicClient.readContract({
            address: gateway,
            abi: X402GatewayABI,
            functionName: 'usdc',
          }),
          publicClient.readContract({
            address: USDC_ADDRESS as `0x${string}`,
            abi: ERC20_BALANCE_ABI,
            functionName: 'balanceOf',
            args: [gateway],
          }),
          publicClient.getLogs({
            address: getAddress(X402_FACTORY_ADDRESS),
            event: GATEWAY_CREATED_EVENT,
            args: { gatewayAddress: gateway },
            fromBlock: X402_FACTORY_DEPLOYMENT_BLOCK,
            toBlock: 'latest',
          }),
        ]);
        if (factoryLogs.length === 0) {
          throw new Error(
            'Address was not created by the approved Kletia X402Factory.',
          );
        }
        if (getAddress(gatewayUsdc) !== getAddress(USDC_ADDRESS)) {
          throw new Error('Gateway token is not Base Mainnet USDC.');
        }
        if (price <= 0n || price > policy.maxGatewayPriceAtomic) {
          throw new Error(
            'Gateway on-chain price is outside the backend safety policy.',
          );
        }

        setActiveContract({
          address: gateway,
          owner: getAddress(owner),
          price: formatUnits(price, NETWORKS.base.tokens.usdc.decimals),
          collected: formatUnits(balance, NETWORKS.base.tokens.usdc.decimals),
          label: 'Loaded Gateway'
        });
        log(`✅ Base gateway loaded. Owner: ${owner.substring(0, 8)}...`);
      }
    } catch (error) {
      log(
        `❌ Contract load failed: ${errorMessage(
          error,
          'Unknown gateway load error.',
        ).substring(0, 80)}`,
      );
    }
  };

  // ── Test Pay with x402 Protocol ────────────────────────────────────────
  const handleTestPay = async () => {
    if (!address || !activeContract) return alert("Wallet must be connected and contract loaded.");
    if (!walletClient) return alert("Wallet client not connected.");
    if (!publicClient) return alert("Base public client is unavailable.");
    if (chainId !== BASE_CHAIN_ID || walletClient.chain?.id !== BASE_CHAIN_ID) {
      return alert(
        `x402 payments are available only on Base Mainnet (${BASE_CHAIN_ID}).`,
      );
    }

    const expectedAccount = getAddress(address);
    const expectedGateway = getAddress(activeContract.address);
    const paymentWalletClient = walletClient;
    const basePublicClient = publicClient;

    setIsTestingPay(true);
    setPayResult(null);
    log("💳 x402 payment flow starting...");

    try {
      assertBaseWalletContext(expectedAccount);
      log('🛡️ Verifying the gateway with the Base security policy...');
      await scanAddress(
        expectedGateway,
        'base',
        'x402_gateway_payment',
      );
      assertBaseWalletContext(expectedAccount);
      log('✅ Gateway security identity verified for Base Mainnet.');

      const [gatewayCode, gatewayToken, livePrice] = await Promise.all([
        basePublicClient.getCode({ address: expectedGateway }),
        basePublicClient.readContract({
          address: expectedGateway,
          abi: X402GatewayABI,
          functionName: 'usdc',
        }),
        basePublicClient.readContract({
          address: expectedGateway,
          abi: X402GatewayABI,
          functionName: 'pricePerCall',
        }),
      ]);
      assertBaseWalletContext(expectedAccount);
      if (!gatewayCode || gatewayCode === '0x') {
        throw new Error('Active gateway has no contract bytecode on Base Mainnet.');
      }
      if (getAddress(gatewayToken) !== getAddress(USDC_ADDRESS)) {
        throw new Error('Active gateway is not configured for Base Mainnet USDC.');
      }
      if (livePrice <= 0n) {
        throw new Error('Active gateway has no positive on-chain price.');
      }
      if (!policy || livePrice > policy.maxGatewayPriceAtomic) {
        throw new Error(
          'Active gateway price exceeds or cannot be checked against the backend policy.',
        );
      }

      const endpointUrl = new URL(
        `${BACKEND_URL}/api/premium/gateway-demo`,
        window.location.origin,
      );
      endpointUrl.searchParams.set('gateway', expectedGateway);
      const endpoint = endpointUrl.toString();
      const commonHeaders = {
        Accept: 'application/json',
        'X-Kletia-Network': 'base',
        'X-Kletia-Chain-Id': String(BASE_CHAIN_ID),
      };

      log(
        `📡 Requesting a server-priced 402 declaration for ${formatUnits(livePrice, NETWORKS.base.tokens.usdc.decimals)} USDC...`,
      );
      const initialResponse = await requestWithTimeout(endpoint, {
        headers: commonHeaders,
      });
      assertBaseWalletContext(expectedAccount);
      if (initialResponse.status !== 402) {
        throw new Error(
          `Expected an unpaid 402 declaration, received HTTP ${initialResponse.status}.`,
        );
      }

      // The signer deliberately exposes no transaction-sending capability.
      // It can only sign the exact, server-declared EIP-3009 authorization.
      const signer = {
        address: expectedAccount,
        signTypedData: async (params: ExactTypedDataRequest) => {
          assertBaseWalletContext(expectedAccount);
          await assertGatewayPrice(expectedGateway, livePrice);
          assertBaseWalletContext(expectedAccount);
          const authorization = validateExactAuthorization(
            params,
            expectedAccount,
            expectedGateway,
            livePrice,
          );
          log("🖊️ Requesting an exact-amount EIP-712 authorization...");
          const signature = await paymentWalletClient.signTypedData({
            account: expectedAccount,
            domain: authorization.domain,
            types: EIP3009_TYPES,
            primaryType: 'TransferWithAuthorization',
            message: authorization.message,
          });
          assertBaseWalletContext(expectedAccount);
          await assertGatewayPrice(expectedGateway, livePrice);
          assertBaseWalletContext(expectedAccount);
          return signature;
        },
      };

      const client = x402Client.fromConfig({
        schemes: [
          {
            network: BASE_CAIP_NETWORK,
            client: new ExactEvmScheme(signer),
          }
        ],
        paymentRequirementsSelector: (version, requirements) => {
          if (version !== X402_PROTOCOL_VERSION) {
            throw new Error(`Unsupported x402 protocol version: ${version}.`);
          }
          if (requirements.length !== 1) {
            throw new Error(
              'x402 server returned an ambiguous payment requirements set.',
            );
          }
          return validatePaymentRequirement(
            requirements[0],
            expectedGateway,
            livePrice,
          );
        },
      });
      const httpClient = new x402HTTPClient(client);
      const paymentRequired = httpClient.getPaymentRequiredResponse(
        (name) => initialResponse.headers.get(name),
      );

      if (
        paymentRequired.x402Version !== X402_PROTOCOL_VERSION ||
        paymentRequired.error
      ) {
        throw new Error(
          paymentRequired.error ||
            `Unsupported x402 declaration version: ${paymentRequired.x402Version}.`,
        );
      }
      const declaredResource = new URL(
        paymentRequired.resource.url,
        endpointUrl.origin,
      );
      const declaredGateway = declaredResource.searchParams.get('gateway');
      const declaredParams = [...declaredResource.searchParams.keys()];
      if (
        declaredResource.origin !== endpointUrl.origin ||
        declaredResource.pathname !== endpointUrl.pathname ||
        !declaredGateway ||
        !isAddress(declaredGateway) ||
        getAddress(declaredGateway) !== expectedGateway ||
        declaredParams.length !== 1 ||
        declaredParams[0] !== 'gateway'
      ) {
        throw new Error(
          'x402 declaration resource does not exactly match the requested gateway endpoint.',
        );
      }

      const paymentPayload = await client.createPaymentPayload(paymentRequired);
      assertBaseWalletContext(expectedAccount);
      await assertGatewayPrice(expectedGateway, livePrice);
      assertBaseWalletContext(expectedAccount);
      if (
        paymentPayload.x402Version !== X402_PROTOCOL_VERSION ||
        !paymentPayload.accepted
      ) {
        throw new Error('x402 client produced an invalid payment payload.');
      }
      validatePaymentRequirement(
        paymentPayload.accepted,
        expectedGateway,
        livePrice,
      );

      const paidHeaders = new Headers(commonHeaders);
      for (const [name, value] of Object.entries(
        httpClient.encodePaymentSignatureHeader(paymentPayload),
      )) {
        paidHeaders.set(name, value);
      }
      assertBaseWalletContext(expectedAccount);
      const response = await requestWithTimeout(endpoint, {
        headers: paidHeaders,
      });
      assertBaseWalletContext(expectedAccount);

      const processed = await httpClient.processPaymentResult(
        paymentPayload,
        (name) => response.headers.get(name),
        response.status,
      );
      if (processed.recovered) {
        throw new Error(
          'x402 channel recovery requested a second authorization; automatic retry is disabled.',
        );
      }
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Paid request returned HTTP ${response.status}: ${errorText.substring(0, 160)}`,
        );
      }

      const settlementHeader =
        response.headers.get('PAYMENT-RESPONSE') ||
        response.headers.get('X-PAYMENT-RESPONSE');
      if (!settlementHeader) {
        throw new Error(
          'Paid response omitted x402 settlement evidence; premium data was not accepted.',
        );
      }
      const settlement = decodePaymentResponseHeader(settlementHeader);
      if (
        !settlement.success ||
        settlement.network !== BASE_CAIP_NETWORK ||
        !settlement.payer ||
        !isAddress(settlement.payer) ||
        getAddress(settlement.payer) !== expectedAccount
      ) {
        throw new Error(
          settlement.errorMessage ||
            settlement.errorReason ||
            'x402 settlement evidence failed network or payer validation.',
        );
      }
      if (
        settlement.amount &&
        (!/^(?:0|[1-9]\d*)$/.test(settlement.amount) ||
          BigInt(settlement.amount) !== livePrice)
      ) {
        throw new Error('x402 settled amount differs from the authorized amount.');
      }

      if (
        !settlement.transaction ||
        !/^0x[0-9a-fA-F]{64}$/.test(settlement.transaction) ||
        /^0x0{64}$/i.test(settlement.transaction)
      ) {
        throw new Error('x402 exact settlement returned no valid transaction hash.');
      }
      const transaction = settlement.transaction as Hex;
      const receipt = await basePublicClient.waitForTransactionReceipt({
        hash: transaction,
        confirmations: 1,
        timeout: 30_000,
      });
      assertBaseWalletContext(expectedAccount);
      assertReceiptSuccess(receipt);
      if (
        !receipt.to ||
        getAddress(receipt.to) !== getAddress(USDC_ADDRESS)
      ) {
        throw new Error(
          'x402 exact settlement receipt target is not Base Mainnet USDC.',
        );
      }
      const exactTransferFound = receipt.logs.some((entry) => {
        if (getAddress(entry.address) !== getAddress(USDC_ADDRESS)) return false;
        try {
          const decoded = decodeEventLog({
            abi: ERC20_TRANSFER_EVENT_ABI,
            data: entry.data,
            topics: entry.topics,
          });
          return (
            decoded.eventName === 'Transfer' &&
            getAddress(decoded.args.from) === expectedAccount &&
            getAddress(decoded.args.to) === expectedGateway &&
            decoded.args.value === livePrice
          );
        } catch {
          return false;
        }
      });
      if (!exactTransferFound) {
        throw new Error(
          'Base receipt does not prove the exact USDC transfer to the gateway.',
        );
      }
      const paymentEvidence: VerifiedPaymentEvidence = {
        network: BASE_CAIP_NETWORK,
        payer: expectedAccount,
        amountAtomic: livePrice.toString(),
        amount: formatUnits(
          livePrice,
          NETWORKS.base.tokens.usdc.decimals,
        ),
        evidence: 'base_receipt',
        transaction,
        blockNumber: receipt.blockNumber.toString(),
        finality: 'base_inclusion',
      };
      log(
        `✅ Exact Base USDC transfer receipt succeeded in block ${receipt.blockNumber}; inclusion is verified, L1 finality is not asserted.`,
      );

      const data = await response.json().catch(() => {
        throw new Error('Premium endpoint returned invalid JSON after settlement.');
      });
      if (
        !data ||
        typeof data !== 'object' ||
        (data as { status?: unknown }).status !== 'success'
      ) {
        throw new Error(
          'Premium endpoint did not return a live success payload after settlement.',
        );
      }

      setPayResult({ payment: paymentEvidence, data });
      log("🎉 x402 settlement evidence and live premium data verified.");
      await Promise.all([refetchBalance(), refetchPrice()]);
    } catch (error) {
      const message = errorMessage(error, 'Unknown x402 payment error.');
      log(`❌ Payment stopped: ${message.substring(0, 200)}`);
      setPayResult({ error: true, message });
    } finally {
      setIsTestingPay(false);
    }
  };

  // ── Debug x402 Response ────────────────────────────────────────────────
  const handleDebug = async () => {
    if (!activeContract) return;
    log("🔍 Fetching x402 debug info...");

    try {
      const res = await requestWithTimeout(
        `${BACKEND_URL}/api/premium/debug-x402?gateway=${activeContract.address}`,
        {
          headers: {
            Accept: 'application/json',
            'X-Kletia-Network': 'base',
            'X-Kletia-Chain-Id': String(BASE_CHAIN_ID),
          },
        },
      );
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        throw new Error(
          data?.error || `Debug endpoint returned HTTP ${res.status}.`,
        );
      }
      const requirement = Array.isArray(
        data.decoded_payment_required?.accepts,
      )
        ? data.decoded_payment_required.accepts[0]
        : null;
      setDebugInfo({
        status: data.x402_status,
        payTo: requirement?.payTo || data.payTo_used || 'Missing',
        price: requirement?.amount || 'Missing',
        network: requirement?.network || 'Missing',
        error: data.decoded_payment_required?.error
      });
      log(
        `✅ Debug declaration read: HTTP ${data.x402_status}, payTo=${String(requirement?.payTo || data.payTo_used).substring(0, 10)}...`,
      );
    } catch (error) {
      const message = errorMessage(error, 'Unknown debug error.');
      log(`❌ Debug error: ${message}`);
    }
  };

  // ── Set Price ──────────────────────────────────────────────────────────
  const handleSetPrice = async () => {
    if (!address || !activeContract) return alert("Wallet ve kontrat gerekli.");
    if (!policy) {
      return alert(
        policyError || 'The backend x402 safety policy is unavailable.',
      );
    }
    if (chainId !== BASE_CHAIN_ID) {
      return alert(`Switch your wallet to Base Mainnet (${BASE_CHAIN_ID}).`);
    }
    log(`💰 Updating price: ${newPrice} USDC...`);

    try {
      if (!publicClient) {
        throw new Error('Base public client is unavailable.');
      }
      const owner = await publicClient.readContract({
        address: getAddress(activeContract.address),
        abi: X402GatewayABI,
        functionName: 'owner',
      });
      if (getAddress(owner) !== getAddress(address)) {
        throw new Error('Connected wallet is not the gateway owner.');
      }
      const priceAtomic = parseUsdcPrice(
        newPrice,
        'New price',
        policy.maxGatewayPriceAtomic,
      );
      const txHash = await writeContractAsync({
        securityAction: 'x402_gateway_admin',
        address: activeContract.address as `0x${string}`,
        abi: X402GatewayABI,
        functionName: 'setPrice',
        args: [priceAtomic],
        chainId: BASE_CHAIN_ID,
      });
      log(`📤 Set Price TX: ${txHash.substring(0, 16)}...`);

      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      assertReceiptSuccess(receipt);
      await refetchPrice();
      log(
        `✅ Price update included with a successful Base receipt in block ${receipt.blockNumber}; L1 finality is not asserted.`,
      );
    } catch (error) {
      const message = errorMessage(error, 'Unknown price update error.');
      log(`❌ Price update error: ${message.substring(0, 100)}`);
    }
  };

  // ── Withdraw ───────────────────────────────────────────────────────────
  const handleWithdraw = async () => {
    if (!address || !activeContract) return alert("Wallet ve kontrat gerekli.");
    if (chainId !== BASE_CHAIN_ID) {
      return alert(`Switch your wallet to Base Mainnet (${BASE_CHAIN_ID}).`);
    }
    log("💸 Starting USDC withdrawal...");

    try {
      if (!publicClient) {
        throw new Error('Base public client is unavailable.');
      }
      const owner = await publicClient.readContract({
        address: getAddress(activeContract.address),
        abi: X402GatewayABI,
        functionName: 'owner',
      });
      if (getAddress(owner) !== getAddress(address)) {
        throw new Error('Connected wallet is not the gateway owner.');
      }
      const txHash = await writeContractAsync({
        securityAction: 'x402_gateway_admin',
        address: activeContract.address as `0x${string}`,
        abi: X402GatewayABI,
        functionName: 'withdraw',
        args: [address],
        chainId: BASE_CHAIN_ID,
      });
      log(`📤 Withdraw TX: ${txHash.substring(0, 16)}...`);

      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      assertReceiptSuccess(receipt);
      await refetchBalance();
      log(
        `✅ Withdrawal included with a successful Base receipt in block ${receipt.blockNumber}; L1 finality is not asserted.`,
      );
    } catch (error) {
      const message = errorMessage(error, 'Unknown withdrawal error.');
      log(`❌ Withdrawal error: ${message.substring(0, 100)}`);
    }
  };

  // ── Refresh on-chain data ──────────────────────────────────────────────
  const handleRefresh = async () => {
    log('🔄 Refreshing on-chain price, balance and x402 declaration...');
    try {
      await Promise.all([refetchPrice(), refetchBalance(), handleDebug()]);
      log('✅ Live Base reads and x402 declaration refresh completed.');
    } catch (error) {
      log(
        `❌ Refresh failed: ${
          errorMessage(error, 'unknown error')
        }`,
      );
    }
  };

  // ── Copy gateway URL ───────────────────────────────────────────────────
  const copyGatewayUrl = () => {
    if (!activeContract) return;
    const url = `${BACKEND_URL}/api/premium/gateway-demo?gateway=${activeContract.address}`;
    navigator.clipboard.writeText(url);
    log("📋 Gateway URL copied.");
  };

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="w-full p-0 pb-8 flex flex-col items-center">
      <div className="w-full max-w-5xl space-y-6">

        {}
        <div className="bg-white dark:bg-[#131E32] border-[4px] border-[#1A1A1A] dark:border-[#4B5563] p-6 shadow-[8px_8px_0_#1A1A1A] dark:shadow-[8px_8px_0_#475569]">
          <h1 className="text-3xl font-black text-[#1A1A1A] dark:text-white uppercase flex items-center gap-3">
            <Cpu className="text-[#0052FF]" />
            x402 Seller Studio
          </h1>
          <p className="text-gray-600 dark:text-slate-400 font-bold mt-2">
            Advanced gateway-owner console for Kletia's payment-required endpoint. This is separate from the CDP Bazaar buyer router above.
          </p>
          <div className="flex gap-2 mt-3">
            <span className="text-[10px] font-black bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 px-2 py-1 uppercase">Base Mainnet</span>
            <span className="text-[10px] font-black bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300 px-2 py-1 uppercase">x402 V2</span>
            <span className="text-[10px] font-black bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300 px-2 py-1 uppercase">CDP Facilitator</span>
          </div>
        </div>

        {securityError && (
          <div className="bg-red-600 border-[4px] border-[#1A1A1A] p-4 shadow-[4px_4px_0_#1A1A1A] flex items-start gap-3">
            <Shield className="w-6 h-6 text-white shrink-0" />
            <div className="flex-1">
              <h3 className="font-black text-white uppercase text-sm mb-1">Security Intercepted</h3>
              <p className="text-white text-sm font-bold">{securityError}</p>
            </div>
            <button onClick={clearSecurityError} className="text-white font-black hover:opacity-70">X</button>
          </div>
        )}

        {policyError && (
          <div className="bg-amber-300 border-[4px] border-[#1A1A1A] p-4 shadow-[4px_4px_0_#1A1A1A] flex items-start gap-3">
            <AlertTriangle className="w-6 h-6 text-amber-950 shrink-0" />
            <div>
              <h3 className="font-black text-amber-950 uppercase text-sm mb-1">
                x402 Policy Unavailable
              </h3>
              <p className="text-amber-950 text-sm font-bold">{policyError}</p>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

          {}
          <div className="space-y-6">
            <div className="bg-white dark:bg-[#1A2841] border-[4px] border-[#1A1A1A] dark:border-[#4B5563] p-6 shadow-[6px_6px_0_#1A1A1A] dark:shadow-[6px_6px_0_#475569]">
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-black text-gray-500 uppercase mb-2">Contract Label</label>
                  <input
                    type="text"
                    value={contractLabel}
                    onChange={(e) => setContractLabel(e.target.value)}
                    className="w-full bg-gray-50 dark:bg-[#131E32] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] p-3 font-bold text-[#1A1A1A] dark:text-white outline-none focus:border-[#0052FF] transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-sm font-black text-gray-500 uppercase mb-2">Price / Call (USDC)</label>
                  <input
                    type="number"
                    step="0.000001"
                    min="0.000001"
                    value={initialPrice}
                    onChange={(e) => setInitialPrice(e.target.value)}
                    className="w-full bg-gray-50 dark:bg-[#131E32] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] p-3 font-bold text-[#1A1A1A] dark:text-white outline-none focus:border-[#0052FF] transition-colors"
                  />
                </div>
                <button
                  onClick={handleDeploy}
                  disabled={isDeploying || !!activeContract || isCheckingSecurity}
                  className="w-full bg-[#0052FF] hover:bg-blue-700 disabled:bg-gray-400 text-white font-black p-4 border-[3px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] active:translate-y-1 active:shadow-none transition-all uppercase flex justify-center items-center gap-2"
                >
                  {isDeploying || isCheckingSecurity ? <RefreshCw className="animate-spin" size={18} /> : <Plus size={18} />}
                  {isCheckingSecurity ? 'Scanning...' : isDeploying ? 'Deploying...' : 'Deploy My x402 Contract'}
                </button>

              </div>
            </div>

            {}
            <div className="bg-gray-100 dark:bg-[#131E32] border-[3px] border-dashed border-gray-300 dark:border-[#4B5563] p-6 rounded-xl">
              <h3 className="font-black text-gray-400 uppercase tracking-widest mb-4">FLOW</h3>
              <div className="space-y-4">
                {[
                  { step: '1', title: 'Deploy', desc: 'Your wallet creates a contract that requires USDC before serving a paid endpoint.' },
                  { step: '2', title: 'Price', desc: 'Each call reads the on-chain price, so you can update the fee later as the owner.' },
                  { step: '3', title: 'Pay', desc: 'The client signs only the exact EIP-3009 Base USDC transfer declared by the verified server policy.' },
                  { step: '4', title: 'Withdraw', desc: 'Only the owner wallet can withdraw the gateway USDC balance.' },
                ].map(f => (
                  <div key={f.step} className="flex gap-3">
                    <div className="w-8 h-8 rounded-full bg-gray-200 dark:bg-slate-700 flex items-center justify-center font-black text-sm shrink-0">{f.step}</div>
                    <div>
                      <h4 className="font-bold text-[#1A1A1A] dark:text-white">{f.title}</h4>
                      <p className="text-sm text-gray-500 dark:text-slate-400">{f.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {}
          <div className="space-y-6">
            {!activeContract ? (
              <div className="bg-white dark:bg-[#1A2841] border-[4px] border-[#1A1A1A] dark:border-[#4B5563] p-6 shadow-[6px_6px_0_#1A1A1A] dark:shadow-[6px_6px_0_#475569] flex flex-col items-center justify-center text-center min-h-[300px]">
                <Settings className="w-16 h-16 text-gray-300 dark:text-slate-600 mb-4" />
                <h3 className="text-xl font-black text-gray-400">NO ACTIVE CONTRACT</h3>
                <p className="text-sm text-gray-500 mt-2 font-bold">Deploy a new contract or load an existing one.</p>

                <div className="w-full mt-8 pt-6 border-t-[3px] border-dashed border-gray-200 dark:border-[#4B5563]">
                  <label className="block text-sm font-black text-gray-500 uppercase mb-2">Load Existing Contract</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      placeholder="0x..."
                      value={loadAddress}
                      onChange={(e) => setLoadAddress(e.target.value)}
                      className="flex-1 bg-gray-50 dark:bg-[#131E32] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] p-2 font-mono text-sm text-[#1A1A1A] dark:text-white outline-none"
                    />
                    <button
                      onClick={handleLoadContract}
                      className="bg-gray-800 text-white font-black px-4 border-[3px] border-[#1A1A1A] uppercase hover:bg-gray-700 transition-colors"
                    >
                      Load
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="bg-[#E8F5E9] dark:bg-[#132A1D] border-[4px] border-green-600 p-6 shadow-[6px_6px_0_#16A34A]">
                <div className="flex items-center gap-2 text-green-700 dark:text-green-400 font-black mb-4">
                  <CheckCircle size={20} />
                  Base gateway loaded. Every payment is revalidated before signing.
                </div>

                {}
                <div className="bg-white dark:bg-[#1A2841] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] p-4 mb-6">
                  <h3 className="font-black text-lg mb-4 text-[#1A1A1A] dark:text-white flex items-center justify-between">
                    ACTIVE x402 CONTRACT
                    <span className="text-xs bg-green-200 dark:bg-green-900/50 text-green-800 dark:text-green-300 px-2 py-1 uppercase font-black">BASE ONCHAIN</span>
                  </h3>

                  <div className="space-y-3 font-mono text-sm">
                    {[
                      { label: 'Address', value: `${activeContract.address.substring(0, 10)}...${activeContract.address.substring(36)}`, color: 'text-[#0052FF]' },
                      { label: 'Owner', value: `${activeContract.owner.substring(0, 8)}...${activeContract.owner.substring(38)}`, color: 'text-[#1A1A1A] dark:text-white' },
                      { label: 'Price', value: `${displayedContractPrice} USDC`, color: 'text-[#1A1A1A] dark:text-white' },
                      { label: 'USDC Balance', value: `${displayedContractBalance} USDC`, color: 'font-black text-green-600 dark:text-green-400' },
                    ].map(row => (
                      <div key={row.label} className="flex justify-between items-center border-b border-gray-100 dark:border-slate-700 pb-2 last:border-0">
                        <span className="text-gray-500 font-sans font-bold uppercase">{row.label}</span>
                        <span className={`font-bold ${row.color}`}>{row.value}</span>
                      </div>
                    ))}
                  </div>

                  {}
                  <div className="flex gap-2 mt-4">
                    <button onClick={copyGatewayUrl} className="flex-1 flex items-center justify-center gap-2 bg-gray-100 dark:bg-slate-700 text-gray-700 dark:text-white font-bold p-2 text-xs uppercase hover:bg-gray-200 dark:hover:bg-slate-600 transition-colors">
                      <Copy size={14} /> Copy Link
                    </button>
                    <a href={`https://basescan.org/address/${activeContract.address}`} target="_blank" rel="noreferrer" className="flex-1 flex items-center justify-center gap-2 bg-gray-100 dark:bg-slate-700 text-gray-700 dark:text-white font-bold p-2 text-xs uppercase hover:bg-gray-200 dark:hover:bg-slate-600 transition-colors cursor-pointer">
                      <ExternalLink size={14} /> Basescan
                    </a>
                    <button onClick={handleRefresh} className="flex-none flex items-center justify-center w-10 bg-gray-100 dark:bg-slate-700 text-gray-700 dark:text-white font-bold p-2 hover:bg-gray-200 dark:hover:bg-slate-600 transition-colors">
                      <RefreshCw size={14} />
                    </button>
                  </div>
                </div>

                {}
                <div className="space-y-4">
                  {}
                  <button
                    onClick={handleTestPay}
                    disabled={
                      isTestingPay ||
                      isCheckingSecurity ||
                      !policy ||
                      chainId !== BASE_CHAIN_ID ||
                      !walletClient
                    }
                    className="w-full bg-[#1A1A1A] dark:bg-white text-white dark:text-[#1A1A1A] hover:bg-gray-800 dark:hover:bg-gray-200 disabled:opacity-50 font-black p-3 border-[3px] border-[#1A1A1A] dark:border-[#4B5563] uppercase flex justify-center items-center gap-2 shadow-[3px_3px_0_#1A1A1A] active:translate-y-1 active:shadow-none transition-all"
                  >
                    {isTestingPay ? <RefreshCw className="animate-spin" size={16} /> : <DollarSign size={16} />}
                    {isTestingPay
                      ? 'Verifying x402...'
                      : chainId !== BASE_CHAIN_ID
                        ? 'Switch Wallet to Base'
                        : `Test Pay ${displayedContractPrice} USDC`}
                  </button>

                  {}
                  <div className="flex gap-2">
                    <input
                      type="number"
                      step="0.000001"
                      min="0.000001"
                      value={newPrice}
                      onChange={(e) => setNewPrice(e.target.value)}
                      disabled={isTestingPay || isCheckingSecurity}
                      className="w-24 bg-white dark:bg-[#131E32] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] p-2 font-bold text-[#1A1A1A] dark:text-white text-center outline-none"
                    />
                    <button disabled={isTestingPay || isCheckingSecurity || !policy} onClick={handleSetPrice} className="flex-1 bg-white dark:bg-slate-800 text-[#1A1A1A] dark:text-white hover:bg-gray-50 border-[3px] border-[#1A1A1A] dark:border-[#4B5563] font-black p-2 uppercase shadow-[2px_2px_0_#1A1A1A] dark:shadow-[2px_2px_0_#475569] active:translate-y-1 active:shadow-none transition-all disabled:opacity-50">
                      <Settings size={14} className="inline mr-2" />{isCheckingSecurity ? 'Wait' : 'Set Price'}
                    </button>
                  </div>

                  {}
                  <button onClick={handleDebug} className="w-full bg-gray-200 dark:bg-slate-700 text-gray-700 dark:text-white hover:bg-gray-300 dark:hover:bg-slate-600 font-bold p-2 border-[2px] border-gray-300 dark:border-[#4B5563] uppercase text-sm flex justify-center items-center gap-2 transition-colors">
                    <Info size={14} /> Debug x402 Response
                  </button>

                  {}
                  <button disabled={isTestingPay || isCheckingSecurity} onClick={handleWithdraw} className="w-full bg-amber-400 hover:bg-amber-500 disabled:opacity-50 text-amber-950 font-black p-3 border-[3px] border-[#1A1A1A] uppercase flex justify-center items-center gap-2 shadow-[4px_4px_0_#1A1A1A] active:translate-y-1 active:shadow-none transition-all">
                    <ArrowDownToLine size={18} /> Withdraw Gateway USDC
                  </button>

                  {}
                  <button
                    onClick={() => { setActiveContract(null); setDebugInfo(null); setPayResult(null); log("🗑️ Contract reset."); }}
                    disabled={isTestingPay || isCheckingSecurity}
                    className="w-full text-gray-400 hover:text-red-500 font-bold text-xs uppercase py-2 transition-colors"
                  >
                    Reset / Load Different Contract
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {}
        {debugInfo && (
          <div className="bg-gray-900 border-[3px] border-[#0052FF] p-4 shadow-[4px_4px_0_#0052FF]">
            <h3 className="font-black text-[#0052FF] uppercase mb-3 flex items-center gap-2">
              <Shield size={16} /> x402 Debug Info
            </h3>
            <div className="grid grid-cols-2 gap-2 font-mono text-xs text-gray-300">
              <div>Status: <span className={debugInfo.status === 402 ? 'text-yellow-400' : 'text-red-400'}>{debugInfo.status}</span></div>
              <div>Network: <span className="text-blue-400">{debugInfo.network}</span></div>
              <div className="col-span-2">PayTo: <span className="text-white">{debugInfo.payTo}</span></div>
              <div className="col-span-2">Price: <span className="text-green-400">{debugInfo.price}</span></div>
              {debugInfo.error && <div className="col-span-2 text-red-400">Error: {debugInfo.error}</div>}
            </div>
          </div>
        )}

        {}
        {payResult && (
          <div className={`border-[3px] p-4 shadow-[4px_4px_0] ${payResult.error ? 'bg-red-50 dark:bg-red-900/20 border-red-500 shadow-red-500' : 'bg-green-50 dark:bg-green-900/20 border-green-500 shadow-green-500'}`}>
            <h3 className={`font-black uppercase mb-2 flex items-center gap-2 ${payResult.error ? 'text-red-600' : 'text-green-600'}`}>
              {payResult.error ? <AlertTriangle size={16} /> : <Zap size={16} />}
              {payResult.error ? 'Payment Stopped' : 'x402 Settlement Verified'}
            </h3>
            <pre className="text-xs font-mono overflow-auto max-h-32 text-gray-700 dark:text-gray-300">
              {JSON.stringify(payResult, null, 2)}
            </pre>
          </div>
        )}

        {}
        <div className="bg-gray-900 border-[3px] border-gray-700 p-4">
          <h3 className="font-black text-gray-500 uppercase tracking-widest mb-2 text-xs">Console Log</h3>
          <div className="space-y-1 font-mono text-xs max-h-40 overflow-y-auto custom-scrollbar">
            {statusLog.length === 0 ? (
              <div className="text-gray-600">Waiting for action...</div>
            ) : (
              statusLog.map((msg, i) => (
                <div key={i} className="text-gray-400">{msg}</div>
              ))
            )}
          </div>
        </div>

        {}
        <div className="pt-6 border-t-[4px] border-[#1A1A1A] dark:border-[#4B5563]">
          <h2 className="text-xl font-black text-[#1A1A1A] dark:text-white uppercase mb-4 flex items-center gap-2">
            <Wallet size={20} /> My x402 Contracts
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {activeContract && (
              <div className="bg-white dark:bg-[#1A2841] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] p-4 shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] flex justify-between items-center">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[10px] font-black bg-green-100 text-green-800 px-1.5 py-0.5 uppercase">Active</span>
                    <span className="font-bold text-[#1A1A1A] dark:text-white">{activeContract.label}</span>
                  </div>
                  <div className="font-mono text-xs text-gray-500">{activeContract.address.substring(0, 8)}...{activeContract.address.substring(38)}</div>
                </div>
                <div className="text-right">
                  <div className="font-bold text-sm text-[#1A1A1A] dark:text-white">{displayedContractPrice} USDC/call</div>
                  <div className="font-black text-green-600 text-sm">Balance: {displayedContractBalance} USDC</div>
                </div>
              </div>
            )}

            <div className="bg-gray-50 dark:bg-[#131E32] border-[3px] border-dashed border-gray-300 dark:border-[#4B5563] p-4 flex items-center justify-center text-center opacity-70">
              <div className="text-gray-400 text-sm font-bold">
                <Plus size={20} className="inline mr-2" />
                Deploy or load more contracts
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
};
