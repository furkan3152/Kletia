import { getAddress, isAddress } from 'viem';
import type {
  EntityAssetField,
  EntityClarification,
  IntentEntityResolution,
  IntentResponse,
  RecipientResolutionEvidence,
} from '../types';
import type { NetworkMode } from '../config/networks';

type UnknownRecord = Record<string, unknown>;

export type EntityResolutionExpectation = {
  network: NetworkMode;
  chainId: number;
  requestId: string;
  userAddress: string;
  action?: string;
};

export const collectEntityResolutionWarnings = (
  evidence: Pick<
    IntentEntityResolution,
    'warnings' | 'assets' | 'recipients'
  >,
): string[] => Array.from(new Set([
  ...evidence.warnings,
  ...evidence.assets.flatMap((asset) => asset.warnings),
  ...evidence.recipients.flatMap((recipient) =>
    recipient.warning ? [recipient.warning] : [],
  ),
]));

const ASSET_FIELDS = new Set<EntityAssetField>([
  'tokenIn',
  'tokenOut',
  'collateralToken',
  'borrowToken',
]);
const REPRESENTATIONS = new Set([
  'native',
  'erc20',
  'native_with_erc20_interface',
  'app_kit_symbol',
]);
const MATCH_METHODS = new Set([
  'canonical_symbol',
  'curated_alias',
  'exact_address',
  'portfolio_verified_address',
  'protocol_fixed_asset',
]);
const TRUST_TIERS = new Set([
  'core',
  'established',
  'elevated',
  'project',
  'portfolio',
]);
const TRUST_LABELS = new Set([
  'canonical',
  'reviewed',
  'elevated_risk',
  'project_contract',
  'unlisted_verified',
]);
const SECURITY_STATUS = new Set([
  'manifest_verified',
  'registry_reviewed',
  'provider_passed',
]);
const SECURITY_PROVIDERS = new Set([
  'Kletia reviewed registry',
  'GoPlus',
]);
type AssetRolePolicy = {
  required: readonly EntityAssetField[];
  allowed: readonly EntityAssetField[];
};
const BASE_ASSET_POLICIES: Readonly<Record<string, AssetRolePolicy>> = {
  swap: { required: ['tokenIn', 'tokenOut'], allowed: ['tokenIn', 'tokenOut'] },
  add_liquidity: { required: ['tokenIn', 'tokenOut'], allowed: ['tokenIn', 'tokenOut'] },
  remove_liquidity: { required: ['tokenIn', 'tokenOut'], allowed: ['tokenIn', 'tokenOut'] },
  stake: { required: ['tokenIn'], allowed: ['tokenIn'] },
  liquid_stake: { required: ['tokenIn', 'tokenOut'], allowed: ['tokenIn', 'tokenOut'] },
  liquid_unstake: { required: ['tokenIn', 'tokenOut'], allowed: ['tokenIn', 'tokenOut'] },
  borrow: { required: ['tokenIn'], allowed: ['tokenIn'] },
  lend: { required: ['tokenIn'], allowed: ['tokenIn'] },
  repay: { required: ['tokenIn'], allowed: ['tokenIn'] },
  withdraw: { required: ['tokenIn'], allowed: ['tokenIn'] },
  yield_compare: { required: ['tokenIn'], allowed: ['tokenIn'] },
  bridge: { required: ['tokenIn'], allowed: ['tokenIn'] },
  allora_prediction: { required: ['tokenIn'], allowed: ['tokenIn'] },
};
const ARC_ASSET_POLICIES: Readonly<Record<string, AssetRolePolicy>> = {
  swap: { required: ['tokenIn', 'tokenOut'], allowed: ['tokenIn', 'tokenOut'] },
  stable_swap: { required: ['tokenIn', 'tokenOut'], allowed: ['tokenIn', 'tokenOut'] },
  appkit_send: { required: ['tokenIn'], allowed: ['tokenIn'] },
  appkit_bridge: { required: ['tokenIn'], allowed: ['tokenIn'] },
  stake: { required: ['tokenIn'], allowed: ['tokenIn'] },
  unstake: { required: ['tokenIn'], allowed: ['tokenIn'] },
  vault_deposit: { required: ['tokenIn'], allowed: ['tokenIn'] },
  vault_withdraw: { required: ['tokenIn'], allowed: ['tokenIn'] },
  lending_deposit: {
    required: ['tokenIn', 'collateralToken'],
    allowed: ['tokenIn', 'collateralToken'],
  },
  lending_withdraw: { required: ['tokenIn'], allowed: ['tokenIn'] },
  lending_borrow: {
    required: ['tokenIn', 'borrowToken', 'collateralToken'],
    allowed: ['tokenIn', 'borrowToken', 'collateralToken'],
  },
  lending_repay: {
    required: ['tokenIn', 'borrowToken'],
    allowed: ['tokenIn', 'borrowToken'],
  },
  memo_send: { required: ['tokenIn'], allowed: ['tokenIn'] },
  official_memo_send: { required: ['tokenIn'], allowed: ['tokenIn'] },
  atomic_payout: { required: ['tokenIn'], allowed: ['tokenIn'] },
  add_liquidity: { required: ['tokenIn', 'tokenOut'], allowed: ['tokenIn', 'tokenOut'] },
  remove_liquidity: { required: [], allowed: ['tokenIn', 'tokenOut'] },
};
const NON_ASSET_ACTIONS: Readonly<Record<NetworkMode, ReadonlySet<string>>> = {
  base: new Set([
    'chat',
    'portfolio',
    'open_widget',
    'basename_register',
    'basename_renew',
    'deploy_token',
    'mint_nft',
    'agent_action',
    'x402_discover',
    'x402_request',
  ]),
  arc: new Set([
    'chat',
    'portfolio',
    'open_widget',
    'claim_rewards',
    'claim_unstaked',
  ]),
};
const SINGLE_RECIPIENT_ACTIONS = new Set([
  'appkit_send',
  'appkit_bridge',
  'memo_send',
  'official_memo_send',
]);
const ISO_TIME_MAX_FUTURE_MS = 5 * 60 * 1_000;

const assetRolePolicy = (
  network: NetworkMode,
  action: string,
): AssetRolePolicy | null | undefined => {
  const configured = network === 'base'
    ? BASE_ASSET_POLICIES[action]
    : ARC_ASSET_POLICIES[action];
  if (configured) return configured;
  return NON_ASSET_ACTIONS[network].has(action) ? null : undefined;
};

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isBoundedString = (
  value: unknown,
  min = 1,
  max = 240,
): value is string =>
  typeof value === 'string' &&
  value.length >= min &&
  value.length <= max &&
  value.trim() === value;

const isCanonicalAddress = (value: unknown): value is string => {
  if (typeof value !== 'string' || !isAddress(value)) return false;
  try {
    return getAddress(value) === value;
  } catch {
    return false;
  }
};

const sameAddress = (left: unknown, right: unknown): boolean =>
  typeof left === 'string' &&
  typeof right === 'string' &&
  isAddress(left) &&
  isAddress(right) &&
  getAddress(left) === getAddress(right);

const isIsoTimestamp = (value: unknown): value is string => {
  if (!isBoundedString(value, 20, 40)) return false;
  const parsed = Date.parse(value);
  return (
    Number.isFinite(parsed) &&
    parsed <= Date.now() + ISO_TIME_MAX_FUTURE_MS
  );
};

const isWarnings = (value: unknown, max = 12): value is string[] =>
  Array.isArray(value) &&
  value.length <= max &&
  value.every((warning) => isBoundedString(warning, 1, 500));

const isClarificationOption = (value: unknown): boolean =>
  isRecord(value) &&
  isBoundedString(value.id, 1, 160) &&
  isBoundedString(value.label, 1, 160) &&
  isBoundedString(value.symbol, 1, 32) &&
  isBoundedString(value.trustLabel, 1, 64) &&
  (value.address === undefined || isCanonicalAddress(value.address));

export const isEntityClarification = (
  value: unknown,
): value is EntityClarification => {
  if (!isRecord(value)) return false;
  if (
    value.kind !== 'asset' &&
    value.kind !== 'recipient' &&
    value.kind !== 'protocol'
  ) {
    return false;
  }
  if (
    !isBoundedString(value.code, 1, 96) ||
    !isBoundedString(value.question, 1, 500) ||
    (value.reference !== undefined &&
      !isBoundedString(value.reference, 1, 240)) ||
    !Array.isArray(value.options) ||
    value.options.length > 4 ||
    !value.options.every(isClarificationOption)
  ) {
    return false;
  }
  const expectedField =
    value.kind === 'asset'
      ? typeof value.field === 'string' &&
        ASSET_FIELDS.has(value.field as EntityAssetField)
      : value.field === value.kind;
  if (!expectedField) return false;
  const optionIds = value.options.map((option) => option.id);
  return new Set(optionIds).size === optionIds.length;
};

const isOnchainEvidence = (value: unknown): boolean =>
  isRecord(value) &&
  isBoundedString(value.observedAtBlock, 1, 80) &&
  typeof value.codeHash === 'string' &&
  /^0x[\da-f]{64}$/iu.test(value.codeHash) &&
  value.metadataBounded === true &&
  typeof value.balanceAtomic === 'string' &&
  /^\d+$/u.test(value.balanceAtomic) &&
  value.balanceVerified === true;

const isAssetEvidence = (value: unknown, action: string): boolean => {
  if (!isRecord(value)) return false;
  if (
    typeof value.role !== 'string' ||
    !ASSET_FIELDS.has(value.role as EntityAssetField) ||
    !isBoundedString(value.originalReference, 1, 240) ||
    !isBoundedString(value.canonicalSymbol, 1, 32) ||
    !isBoundedString(value.displayName, 1, 160) ||
    (value.address !== undefined && !isCanonicalAddress(value.address)) ||
    !Number.isInteger(value.decimals) ||
    Number(value.decimals) < 0 ||
    Number(value.decimals) > 36 ||
    typeof value.representation !== 'string' ||
    !REPRESENTATIONS.has(value.representation) ||
    typeof value.matchedBy !== 'string' ||
    !MATCH_METHODS.has(value.matchedBy) ||
    typeof value.identityConfidence !== 'number' ||
    value.identityConfidence < 0 ||
    value.identityConfidence > 100 ||
    typeof value.trustScore !== 'number' ||
    value.trustScore < 0 ||
    value.trustScore > 100 ||
    typeof value.trustTier !== 'string' ||
    !TRUST_TIERS.has(value.trustTier) ||
    typeof value.trustLabel !== 'string' ||
    !TRUST_LABELS.has(value.trustLabel) ||
    !isWarnings(value.warnings)
  ) {
    return false;
  }
  if (
    (value.representation === 'erc20' ||
      value.representation === 'native_with_erc20_interface') &&
    value.address === undefined
  ) {
    return false;
  }
  if (!isRecord(value.security)) return false;
  if (
    typeof value.security.status !== 'string' ||
    !SECURITY_STATUS.has(value.security.status) ||
    typeof value.security.provider !== 'string' ||
    !SECURITY_PROVIDERS.has(value.security.provider) ||
    !isIsoTimestamp(value.security.observedAt) ||
    (value.security.catalogRevision !== undefined &&
      !isBoundedString(value.security.catalogRevision, 1, 80)) ||
    (value.security.primarySource !== undefined &&
      !isBoundedString(value.security.primarySource, 1, 500))
  ) {
    return false;
  }
  if (
    value.security.status === 'provider_passed' &&
    value.security.provider !== 'GoPlus'
  ) {
    return false;
  }
  if (
    value.security.status !== 'provider_passed' &&
    value.security.provider !== 'Kletia reviewed registry'
  ) {
    return false;
  }
  if (value.onchain !== undefined && !isOnchainEvidence(value.onchain)) {
    return false;
  }
  if (!isRecord(value.actionCompatibility)) return false;
  return (
    value.actionCompatibility.action === action &&
    value.actionCompatibility.allowed === true &&
    Number.isInteger(value.actionCompatibility.executionDecimals) &&
    Number(value.actionCompatibility.executionDecimals) >= 0 &&
    Number(value.actionCompatibility.executionDecimals) <= 36
  );
};

const isRecipientEvidence = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  if (
    value.role !== 'recipient' ||
    !isBoundedString(value.originalReference, 1, 240) ||
    !isCanonicalAddress(value.resolvedAddress) ||
    (value.matchedBy !== 'exact_address' && value.matchedBy !== 'basename') ||
    !isIsoTimestamp(value.observedAt) ||
    typeof value.expiresAt !== 'number' ||
    !Number.isFinite(value.expiresAt) ||
    value.expiresAt <= Date.parse(value.observedAt as string) ||
    value.expiresAt <= Date.now() ||
    typeof value.crossNetworkIdentity !== 'boolean' ||
    (value.warning !== undefined &&
      !isBoundedString(value.warning, 1, 500)) ||
    (value.transferIndex !== undefined &&
      (typeof value.transferIndex !== 'number' ||
        !Number.isInteger(value.transferIndex) ||
        value.transferIndex < 0))
  ) {
    return false;
  }
  if (value.matchedBy === 'basename') {
    return (
      isBoundedString(value.basename, 3, 255) &&
      (value.basename.toLowerCase().endsWith('.base') ||
        value.basename.toLowerCase().endsWith('.base.eth')) &&
      isCanonicalAddress(value.resolver) &&
      isBoundedString(value.observedAtBlock, 1, 80)
    );
  }
  return (
    value.basename === undefined &&
    value.resolver === undefined &&
    value.observedAtBlock === undefined &&
    sameAddress(value.originalReference, value.resolvedAddress)
  );
};

export const responseIntentAction = (
  response: Pick<IntentResponse, 'action' | 'actionType'>,
): string | undefined => {
  const action = response.action?.trim();
  const actionType = response.actionType?.trim();
  if (action && actionType && action !== actionType) return undefined;
  return actionType || action;
};

export const isIntentEntityResolution = (
  value: unknown,
  expected: EntityResolutionExpectation,
): value is IntentEntityResolution => {
  if (!isRecord(value)) return false;
  const action = expected.action?.trim();
  if (
    !action ||
    value.policyVersion !== 'kletia_entity_resolution_v1' ||
    value.requestId !== expected.requestId ||
    value.network !== expected.network ||
    value.chainId !== expected.chainId ||
    !sameAddress(value.userAddress, expected.userAddress) ||
    value.action !== action ||
    value.decision !== 'eligible' ||
    !isIsoTimestamp(value.observedAt) ||
    value.scorePolicy !==
      'informational_only_hard_gates_take_precedence' ||
    !Array.isArray(value.assets) ||
    value.assets.length > 4 ||
    !value.assets.every((asset) => isAssetEvidence(asset, action)) ||
    !Array.isArray(value.recipients) ||
    value.recipients.length > 25 ||
    !value.recipients.every(isRecipientEvidence) ||
    !isWarnings(value.warnings)
  ) {
    return false;
  }
  const roles = value.assets.map((asset) => asset.role);
  if (new Set(roles).size !== roles.length) return false;
  const rolePolicy = assetRolePolicy(expected.network, action);
  if (
    rolePolicy === undefined ||
    (rolePolicy === null && roles.length !== 0) ||
    (rolePolicy !== null &&
      (rolePolicy.required.some((role) => !roles.includes(role)) ||
        roles.some((role) => !rolePolicy.allowed.includes(role))))
  ) {
    return false;
  }
  const transferIndexes = value.recipients
    .map((recipient) => recipient.transferIndex)
    .filter((index): index is number => index !== undefined);
  if (new Set(transferIndexes).size !== transferIndexes.length) return false;
  if (SINGLE_RECIPIENT_ACTIONS.has(action)) {
    if (
      value.recipients.length !== 1 ||
      value.recipients[0].transferIndex !== undefined
    ) {
      return false;
    }
  } else if (action === 'atomic_payout') {
    if (
      value.recipients.length === 0 ||
      value.recipients.some(
        (recipient, index) =>
          recipient.matchedBy !== 'exact_address' ||
          recipient.transferIndex !== index,
      )
    ) {
      return false;
    }
  } else if (value.recipients.length !== 0) {
    return false;
  }
  if (value.protocol !== undefined) {
    if (
      !isRecord(value.protocol) ||
      !isBoundedString(value.protocol.original, 1, 120) ||
      !isBoundedString(value.protocol.canonical, 1, 120) ||
      (value.protocol.matchedBy !== 'curated_alias' &&
        value.protocol.matchedBy !== 'canonical_id')
    ) {
      return false;
    }
  }
  return true;
};

export const basenameRecipientEvidence = (
  evidence: IntentEntityResolution | undefined,
): RecipientResolutionEvidence[] =>
  evidence?.recipients.filter(
    (recipient) => recipient.matchedBy === 'basename',
  ) || [];

export type BasenameRevalidationExpectation = {
  network: NetworkMode;
  chainId: number;
  requestId: string;
  userAddress: string;
  basename: string;
  resolvedAddress: string;
};

export const isBasenameRevalidationResponse = (
  value: unknown,
  expected: BasenameRevalidationExpectation,
): boolean => {
  if (
    !isRecord(value) ||
    value.success !== true ||
    value.status !== 'resolved' ||
    value.network !== expected.network ||
    value.chainId !== expected.chainId ||
    value.requestId !== expected.requestId ||
    !sameAddress(value.userAddress, expected.userAddress) ||
    !isRecipientEvidence(value.recipientResolution)
  ) {
    return false;
  }
  const recipient = value.recipientResolution as UnknownRecord;
  return (
    recipient.matchedBy === 'basename' &&
    typeof recipient.basename === 'string' &&
    recipient.basename.toLowerCase() === expected.basename.toLowerCase() &&
    sameAddress(recipient.resolvedAddress, expected.resolvedAddress) &&
    typeof recipient.expiresAt === 'number' &&
    recipient.expiresAt > Date.now()
  );
};
