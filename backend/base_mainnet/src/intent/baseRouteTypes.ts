import type { Address, Hex } from 'viem';
import type {
    BaseCallerSemantics,
    BaseExecutionMode,
    BaseRiskTier,
} from '../config/baseProtocols.js';

export type BaseLendingAction = 'lend' | 'borrow' | 'repay' | 'withdraw';
export type BaseRiskTolerance = 'conservative' | 'balanced' | 'aggressive';

export interface ExplicitRouteApproval {
    readonly token: Address;
    readonly spender: Address;
    readonly amount: string;
    readonly symbol: string;
    readonly required: true;
}

export interface BaseExecutionEvidence {
    readonly executionMode: BaseExecutionMode;
    readonly callerSemantics: BaseCallerSemantics;
    readonly feeRouterCompatible: boolean;
    readonly chainId: 8453;
    readonly registryVerified: true;
}

export interface BaseYieldEconomics {
    readonly observedAt: string;
    readonly rateKind: 'supply_rate' | 'variable_borrow_rate' | 'position';
    readonly rateBps: number | null;
    readonly availableLiquidityAtomic: string | null;
    readonly positionAtomic: string | null;
    readonly debtAtomic: string | null;
    readonly estimateStatus: 'complete' | 'partial';
    readonly limitation: string;
}

export interface BaseLendingRoute {
    readonly name: string;
    readonly protocolId:
        | 'aave-v3'
        | 'moonwell'
        | 'compound-v3'
        | 'moonwell-vault'
        | 'seamless-vault'
        | 'spark-vault'
        | 'fluid-vault';
    readonly action: BaseLendingAction;
    readonly assetSymbol: string;
    readonly riskTier: BaseRiskTier;
    readonly amount: bigint;
    readonly expectedOutput: string;
    readonly routePath: string;
    readonly router: Address;
    readonly calldata: Hex;
    readonly primaryTokenAddress?: Address;
    readonly primaryAmountInWei?: string;
    readonly approvals: readonly ExplicitRouteApproval[];
    readonly value: '0';
    readonly execution: BaseExecutionEvidence;
    readonly executionMode: 'direct';
    readonly callerSemantics: BaseCallerSemantics;
    readonly feeRouterCompatible: false;
    readonly simulationReturnPolicy?: 'uint256_zero';
    readonly economics: BaseYieldEconomics;
}

export interface BaseYieldRankingEvidence {
    readonly policyVersion: 'base_yield_efficiency_v1';
    readonly action: BaseLendingAction;
    readonly riskTolerance: BaseRiskTolerance;
    readonly primaryMetric: 'supply_rate_bps' | 'borrow_rate_bps' | 'position';
    readonly direction: 'ascending' | 'descending';
    readonly gasCostNormalized: false;
    readonly quoteBlockConsistency: 'best_effort_live_reads';
    readonly limitation: string;
    readonly eligibleRouteCount: number;
    readonly rankedRoutes: readonly {
        readonly rank: number;
        readonly protocolId: string;
        readonly name: string;
        readonly riskTier: BaseRiskTier;
        readonly rateBps: number | null;
        readonly availableLiquidityAtomic: string | null;
        readonly positionAtomic: string | null;
        readonly debtAtomic: string | null;
    }[];
}
