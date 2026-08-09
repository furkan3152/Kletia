import {
  decodeFunctionData,
  encodePacked,
  erc20Abi,
  getAddress,
  hexToString,
  isAddressEqual,
  keccak256,
  toFunctionSelector,
  type Address,
} from 'viem';
import type {
  ArcOfficialPolicyEvidence,
  RouteData,
} from '../types';

export const ARC_OFFICIAL_ADDRESSES = {
  usdc: getAddress('0x3600000000000000000000000000000000000000'),
  memo: getAddress('0x5294E9927c3306DcBaDb03fe70b92e01cCede505'),
  multicall3From: getAddress(
    '0x522fAf9A91c41c443c66765030741e4AaCe147D0',
  ),
} as const;

const ARC_CHAIN_ID = 5_042_002;
const MAX_TOTAL_ATOMIC = '1000000000000';
const REFERENCE = /^[A-Za-z][A-Za-z0-9._:-]{0,63}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TRANSFER_SELECTOR = toFunctionSelector('transfer(address,uint256)');
const MEMO_SELECTOR = toFunctionSelector(
  'memo(address,bytes,bytes32,bytes)',
);
const AGGREGATE3_SELECTOR = toFunctionSelector(
  'aggregate3((address,bool,bytes)[])',
);

const MEMO_ABI = [
  {
    type: 'function',
    name: 'memo',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'target', type: 'address' },
      { name: 'data', type: 'bytes' },
      { name: 'memoId', type: 'bytes32' },
      { name: 'memoData', type: 'bytes' },
    ],
    outputs: [],
  },
] as const;

const MULTICALL3_FROM_ABI = [
  {
    type: 'function',
    name: 'aggregate3',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'allowFailure', type: 'bool' },
          { name: 'callData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      {
        name: 'returnData',
        type: 'tuple[]',
        components: [
          { name: 'success', type: 'bool' },
          { name: 'returnData', type: 'bytes' },
        ],
      },
    ],
  },
] as const;

const selector = (calldata: string): string => {
  if (!/^0x[0-9a-fA-F]{8,}$/.test(calldata)) {
    throw new Error('Arc extension calldata selector içermiyor.');
  }
  return calldata.slice(0, 10).toLowerCase();
};

function assertEvidence(
  evidence: ArcOfficialPolicyEvidence | undefined,
  expectedUser: Address,
) {
  if (
    !evidence ||
    evidence.network !== 'arc-testnet' ||
    evidence.chainId !== ARC_CHAIN_ID ||
    evidence.source !==
      'https://docs.arc.io/arc/references/contract-addresses' ||
    evidence.accountPolicy !== 'EOA_ONLY' ||
    evidence.requiresRuntimeEoaCodeCheck !== true ||
    evidence.valuePolicy !== 'ZERO_ONLY' ||
    evidence.assetDecimals !== 6 ||
    evidence.maxTotalAtomic !== MAX_TOTAL_ATOMIC ||
    !isAddressEqual(getAddress(evidence.asset), ARC_OFFICIAL_ADDRESSES.usdc) ||
    !isAddressEqual(getAddress(evidence.executionAccount), expectedUser) ||
    !/^\d+$/.test(evidence.totalAtomic) ||
    BigInt(evidence.totalAtomic) <= 0n ||
    BigInt(evidence.totalAtomic) > BigInt(MAX_TOTAL_ATOMIC)
  ) {
    throw new Error('Arc extension politika kanıtı geçersiz.');
  }
  return evidence;
}

function expectedMemoId(
  requestId: string,
  user: Address,
  recipient: Address,
  amount: bigint,
) {
  return keccak256(
    encodePacked(
      ['string', 'uint256', 'string', 'address', 'address', 'uint256'],
      [
        'kletia.arc.official-memo.v1',
        BigInt(ARC_CHAIN_ID),
        requestId,
        user,
        recipient,
        amount,
      ],
    ),
  );
}

function assertNestedEvidence(
  evidence: ArcOfficialPolicyEvidence,
  count: number,
) {
  if (
    evidence.nestedCalls.length !== count ||
    evidence.nestedCalls.some(
      (call) =>
        !isAddressEqual(
          getAddress(call.target),
          ARC_OFFICIAL_ADDRESSES.usdc,
        ) ||
        call.selector.toLowerCase() !== TRANSFER_SELECTOR.toLowerCase() ||
        call.allowFailure !== false,
    )
  ) {
    throw new Error('Arc extension iç çağrı kanıtı geçersiz.');
  }
}

export function validateArcOfficialRoute(
  route: RouteData,
  action: string | undefined,
  expectedUserAddress: string,
): { requireEoa: boolean; policyTargets: Address[] } {
  const normalizedAction = String(action || '').toLowerCase();
  const isOfficialMemo = normalizedAction === 'official_memo_send';
  const isAtomicPayout = normalizedAction === 'atomic_payout';
  if (!isOfficialMemo && !isAtomicPayout) {
    if (route.policyEvidence) {
      throw new Error(
        'Normal rotada beklenmeyen Arc extension politika kanıtı bulundu.',
      );
    }
    return { requireEoa: false, policyTargets: [] };
  }

  const user = getAddress(expectedUserAddress);
  const evidence = assertEvidence(route.policyEvidence, user);
  if (route.value !== '0' || (route.approvals || []).length !== 0) {
    throw new Error('Arc extension rotası value veya approval taşıyamaz.');
  }

  if (isOfficialMemo) {
    if (
      !isAddressEqual(getAddress(route.router), ARC_OFFICIAL_ADDRESSES.memo) ||
      selector(route.calldata) !== MEMO_SELECTOR.toLowerCase() ||
      evidence.atomicity !== 'SINGLE_CALL' ||
      !evidence.memo
    ) {
      throw new Error('Resmî Arc Memo rotası geçersiz.');
    }
    const decoded = decodeFunctionData({
      abi: MEMO_ABI,
      data: route.calldata as `0x${string}`,
    });
    const [target, innerData, memoId, memoData] = decoded.args;
    if (
      !isAddressEqual(target, ARC_OFFICIAL_ADDRESSES.usdc) ||
      selector(innerData) !== TRANSFER_SELECTOR.toLowerCase()
    ) {
      throw new Error('Resmî Memo yalnızca Arc USDC transferi sarabilir.');
    }
    const transfer = decodeFunctionData({
      abi: erc20Abi,
      data: innerData,
    });
    if (transfer.functionName !== 'transfer') {
      throw new Error('Resmî Memo iç çağrısı transfer değil.');
    }
    const [recipient, amount] = transfer.args;
    if (
      isAddressEqual(recipient, user) ||
      amount.toString() !== evidence.totalAtomic ||
      (route.primaryAmountInWei !== undefined &&
        amount.toString() !== route.primaryAmountInWei)
    ) {
      throw new Error('Resmî Memo alıcı veya miktar kanıtı eşleşmiyor.');
    }
    const reference = hexToString(memoData);
    if (
      !REFERENCE.test(reference) ||
      !REQUEST_ID.test(evidence.memo.requestId) ||
      evidence.memo.reference !== reference ||
      evidence.memo.id !== memoId ||
      evidence.memo.id !==
        expectedMemoId(
          evidence.memo.requestId,
          user,
          recipient,
          amount,
        ) ||
      evidence.memo.policy !== 'PUBLIC_OPAQUE_ASCII_REFERENCE' ||
      evidence.memo.visibility !== 'PUBLIC_ONCHAIN' ||
      evidence.memo.piiProtection !==
        'FORMAT_ONLY_USER_MUST_EXCLUDE_PII' ||
      evidence.memo.maxBytes !== 64
    ) {
      throw new Error('Resmî Memo reference kanıtı eşleşmiyor.');
    }
    assertNestedEvidence(evidence, 1);
    return {
      requireEoa: true,
      policyTargets: [ARC_OFFICIAL_ADDRESSES.usdc],
    };
  }

  if (
    !isAddressEqual(
      getAddress(route.router),
      ARC_OFFICIAL_ADDRESSES.multicall3From,
    ) ||
    selector(route.calldata) !== AGGREGATE3_SELECTOR.toLowerCase() ||
    evidence.atomicity !== 'ALL_OR_NOTHING' ||
    evidence.memo !== undefined
  ) {
    throw new Error('Resmî Arc atomik payout rotası geçersiz.');
  }
  const decoded = decodeFunctionData({
    abi: MULTICALL3_FROM_ABI,
    data: route.calldata as `0x${string}`,
  });
  const calls = decoded.args[0];
  if (calls.length < 1 || calls.length > 25) {
    throw new Error('Atomik payout çağrı sayısı güvenli sınır dışında.');
  }
  const recipients = new Set<string>();
  let total = 0n;
  calls.forEach((call) => {
    if (
      !isAddressEqual(call.target, ARC_OFFICIAL_ADDRESSES.usdc) ||
      call.allowFailure !== false ||
      selector(call.callData) !== TRANSFER_SELECTOR.toLowerCase()
    ) {
      throw new Error('Atomik payout iç çağrısı allowlist dışında.');
    }
    const transfer = decodeFunctionData({
      abi: erc20Abi,
      data: call.callData,
    });
    if (transfer.functionName !== 'transfer') {
      throw new Error('Atomik payout iç çağrısı transfer değil.');
    }
    const [recipient, amount] = transfer.args;
    const recipientKey = recipient.toLowerCase();
    if (
      isAddressEqual(recipient, user) ||
      recipients.has(recipientKey) ||
      amount <= 0n
    ) {
      throw new Error('Atomik payout alıcı veya miktar politikası geçersiz.');
    }
    recipients.add(recipientKey);
    total += amount;
  });
  if (
    total.toString() !== evidence.totalAtomic ||
    total > BigInt(MAX_TOTAL_ATOMIC)
  ) {
    throw new Error('Atomik payout toplamı politika kanıtıyla eşleşmiyor.');
  }
  assertNestedEvidence(evidence, calls.length);
  return {
    requireEoa: true,
    policyTargets: [ARC_OFFICIAL_ADDRESSES.usdc],
  };
}
