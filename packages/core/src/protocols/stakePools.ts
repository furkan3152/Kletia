/**
 * Solana stake pools.
 */
import type { ProtocolId, VenueContract } from "./types.js";

/** Protocols with pinned Solana SPL stake pools (the adapter serves every pool of its protocol). */
export type StakePoolProtocolId = Extract<ProtocolId, "jito" | "sanctum" | "blazestake">;

/**
 * A Solana SPL stake pool that takes SOL deposits (DepositSolWithSlippage):
 * the program that owns it and the pool fields the adapter checks on-chain.
 */
export interface SolanaStakePool {
  readonly protocol: StakePoolProtocolId;
  /** The LST symbol (an ASSETS row on Solana with the same mint). */
  readonly symbol: string;
  readonly label: string;
  readonly program: string;
  readonly pool: string;
  readonly mint: string;
  readonly reserve: string;
  readonly feeAccount: string;
  readonly validatorList: string;
}

/** Program ids of the three SPL stake pool deployments (Sanctum's LST list names them Spl, SanctumSpl, SanctumSplMulti). */
const SPL_STAKE_POOL_PROGRAM = "SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy";
const SANCTUM_SPL_PROGRAM = "SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY";
const SANCTUM_SPL_MULTI_PROGRAM = "SPMBzsVUuoHA4Jm6KunbsotaahvVikZs1JyTW6iJvbn";

/**
 * Pinned stake pools; within a protocol the first pool is its default. Jito and JupSOL were pinned 2026-10-15.
 * Added 2026-10-23 (pool, mint and validator list from Sanctum's LST list, github.com/igneous-labs/sanctum-lst-list;
 * owner, reserve, fee account, epoch and an open SOL deposit read back and DepositSolWithSlippage simulated
 * on 2026-10-23, fixtures/protocols-2026-10-23-solana.json): hSOL, dSOL and bonkSOL (Sanctum single-validator
 * pools) and BlazeStake bSOL (SPL stake pool program).
 */
export const SOLANA_STAKE_POOLS: readonly SolanaStakePool[] = Object.freeze([
  {
    protocol: "jito", symbol: "JitoSOL", label: "Jito stake pool", program: SPL_STAKE_POOL_PROGRAM, pool: "Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb",
    mint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", reserve: "BgKUXdS29YcHCFrPm5M8oLHiTzZaMDjsebggjoaQ6KFL",
    feeAccount: "8yoigZfzZ1nNaadumY9uPVD118225UYHTDpmjpr2nrSa", validatorList: "3R3nGZpQs2aZo5FDQvd2MUQ6R7KhAPainds6uT6uE2mn",
  },
  {
    protocol: "sanctum", symbol: "JupSOL", label: "Sanctum JupSOL pool", program: SANCTUM_SPL_MULTI_PROGRAM, pool: "8VpRhuxa7sUUepdY3kQiTmX9rS5vx4WgaXiAnXq4KCtr",
    mint: "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v", reserve: "FMAWbzuxsgbgndArunedwxXPA6sweaVUGGgadCpSxau2",
    feeAccount: "GbvFCpMqKX65gQ8KNeob9JUAL7vHCHFSg8YN5bnpPT8g", validatorList: "AXL4v4bbzRkqwHmLc9A1YzHQmRhmG9Q93i1e6CPG2bEK",
  },
  {
    protocol: "sanctum", symbol: "hSOL", label: "Sanctum hSOL pool", program: SANCTUM_SPL_PROGRAM, pool: "3wK2g8ZdzAH8FJ7PKr2RcvGh7V9VYson5hrVsJM5Lmws",
    mint: "he1iusmfkpAdwvxLNGV8Y1iSbj4rUy6yMhEA3fotn9A", reserve: "xdmLgScxrbbUu2gx7j2iqQXVKZYBCTDiCtR7AsHHJYQ",
    feeAccount: "C1mXWyT6CpiatsC2ob4tTTdT6nHJBVmcPzrV5oAXXDT5", validatorList: "TCxWHorDSe3vWydw6MGwyexcqm3ZU9RT7VTqiCcN6y9",
  },
  {
    protocol: "sanctum", symbol: "dSOL", label: "Sanctum dSOL pool", program: SANCTUM_SPL_PROGRAM, pool: "9mhGNSPArRMHpLDMSmxAvuoizBqtBGqYdT8WGuqgxNdn",
    mint: "Dso1bDeDjCQxTrWHqUUi63oBvV7Mdm6WaobLbQ7gnPQ", reserve: "4RjzgujRmdadbLjyh2L1Qn5ECsQ1qfjaapTfeWKYtsC3",
    feeAccount: "4ipvqrPR7dvkRPJ9iHhAxY7NfcgCSrZw5KLH3K8aAbCM", validatorList: "4dRHzwW2npecE4riAKibHccnMib5jBu9RdFf8bQ2o7Mo",
  },
  {
    protocol: "sanctum", symbol: "bonkSOL", label: "Sanctum bonkSOL pool", program: SANCTUM_SPL_PROGRAM, pool: "ArAQfbzsdotoKB5jJcZa3ajQrrPcWr2YQoDAEAiFxJAC",
    mint: "BonK1YhkXEGLZzwtcvRTip3gAL9nCeQD7ppZBLXhtTs", reserve: "5htyN73FSd1dvv8LEHrmy4EiDkXtrGn5EXv5ZizqVF3X",
    feeAccount: "2azKdTLTd7xBF3mKjVBrrpj5jgJHoCRXLNpFjhfgzXwv", validatorList: "Ea2ATXQgQrUXGdMPXUbdNw8SmV3S6RSzsiff8AcBLP2G",
  },
  {
    protocol: "blazestake", symbol: "bSOL", label: "BlazeStake stake pool", program: SPL_STAKE_POOL_PROGRAM, pool: "stk9ApL5HeVAwPLr3TLhDXdZS8ptVu7zp6ov8HFDuMi",
    mint: "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1", reserve: "rsrxDvYUXjH1RQj2Ke36LNZEVqGztATxFkqNukERqFT",
    feeAccount: "Dpo148tVGewDPyh2FkGV18gouWctbdX2fHJopJGe9xv1", validatorList: "1istpXjy8BM7Vd5vPfA485frrV7SRJhgq5vs3sskWmc",
  },
] satisfies readonly SolanaStakePool[]);

/** The pinned stake pools of `protocol` (default first). */
export function stakePoolsFor(protocol: ProtocolId): SolanaStakePool[] {
  return SOLANA_STAKE_POOLS.filter((pool) => pool.protocol === protocol);
}

/** VENUE_CONTRACTS rows of the stake pools: each protocol's programs once, then every pool's accounts. */
export function stakePoolContracts(): VenueContract[] {
  const rows: VenueContract[] = [];
  const add = (row: VenueContract) => {
    if (!rows.some((entry) => entry.protocol === row.protocol && entry.role === row.role && entry.address === row.address)) rows.push(row);
  };
  for (const pool of SOLANA_STAKE_POOLS) {
    const network = "solana";
    add({ protocol: pool.protocol, network, role: "program", address: pool.program });
    add({ protocol: pool.protocol, network, role: "stake-pool", address: pool.pool });
    add({ protocol: pool.protocol, network, role: "pool-mint", address: pool.mint });
    add({ protocol: pool.protocol, network, role: "reserve-stake", address: pool.reserve });
    add({ protocol: pool.protocol, network, role: "fee-account", address: pool.feeAccount });
    add({ protocol: pool.protocol, network, role: "validator-list", address: pool.validatorList });
  }
  return rows;
}
