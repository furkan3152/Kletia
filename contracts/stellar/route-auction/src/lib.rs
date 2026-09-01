// SPDX-License-Identifier: MIT
#![no_std]
#![allow(clippy::too_many_arguments)]

use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype, xdr::ToXdr,
    Address, Bytes, BytesN, Env, Vec,
};

const MAX_BIDS_HARD_LIMIT: u32 = 32;

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BondLockStatus {
    Locked,
    Released,
    Slashed,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BondLock {
    pub solver: Address,
    pub workflow_root: BytesN<32>,
    pub amount: i128,
    pub status: BondLockStatus,
    pub created_at_ledger: u32,
    pub expires_at_ledger: u32,
    pub reclaim_after_ledger: u32,
    pub resolution_hash: Option<BytesN<32>>,
}

#[contractclient(name = "SolverBondVaultClient")]
pub trait SolverBondVault {
    fn bond_lock(env: Env, solver: Address, workflow_root: BytesN<32>) -> Option<BondLock>;
}

#[contract]
pub struct KletiaRouteAuction;

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AuctionStatus {
    Open,
    Finalized,
    NoWinner,
    Succeeded,
    SolverFault,
    Indeterminate,
    Cancelled,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuctionConfig {
    pub bond_vault: Address,
    pub settlement_authority: Address,
    pub max_bids: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuctionRecord {
    pub owner: Address,
    pub workflow_root: BytesN<32>,
    pub constraints_hash: BytesN<32>,
    pub minimum_output: i128,
    pub maximum_solver_fee: i128,
    pub maximum_duration_seconds: u64,
    pub minimum_bond: i128,
    pub commit_deadline_ledger: u32,
    pub reveal_deadline_ledger: u32,
    pub settlement_deadline_ledger: u32,
    pub bid_count: u32,
    pub status: AuctionStatus,
    pub winner: Option<Address>,
    pub winning_route_hash: Option<BytesN<32>>,
    pub winning_net_output: Option<i128>,
    pub result_hash: Option<BytesN<32>>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BidRecord {
    pub solver: Address,
    pub commitment: BytesN<32>,
    pub committed_at_ledger: u32,
    pub revealed_at_ledger: Option<u32>,
    pub route_hash: Option<BytesN<32>>,
    pub quote_evidence_hash: Option<BytesN<32>>,
    pub promised_output: Option<i128>,
    pub solver_fee: Option<i128>,
    pub duration_seconds: Option<u64>,
    pub quote_expires_at_ledger: Option<u32>,
    pub eligible: bool,
}

#[contracttype]
#[derive(Clone)]
struct BidCommitmentPreimage {
    domain_hash: BytesN<32>,
    auction_contract: Address,
    workflow_root: BytesN<32>,
    solver: Address,
    route_hash: BytesN<32>,
    quote_evidence_hash: BytesN<32>,
    promised_output: i128,
    solver_fee: i128,
    duration_seconds: u64,
    quote_expires_at_ledger: u32,
    salt: BytesN<32>,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Config,
    Auction(BytesN<32>),
    Bidders(BytesN<32>),
    Bid(BytesN<32>, Address),
}

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum AuctionError {
    NotInitialized = 1,
    InvalidConfig = 2,
    InvalidHash = 3,
    InvalidAmount = 4,
    InvalidDeadlines = 5,
    AuctionAlreadyExists = 6,
    AuctionNotFound = 7,
    AuctionNotOpen = 8,
    CommitWindowClosed = 9,
    RevealWindowClosed = 10,
    FinalizationWindowClosed = 11,
    BidAlreadyExists = 12,
    BidNotFound = 13,
    BidAlreadyRevealed = 14,
    InvalidCommitment = 15,
    BondLockMissing = 16,
    BondLockInsufficient = 17,
    BondLockExpiresEarly = 18,
    TooManyBids = 19,
    InvalidSettlementState = 20,
    AuctionHasBids = 21,
    ArithmeticOverflow = 22,
    SettlementWindowStillOpen = 23,
}

#[contractevent(topics = ["auction_opened"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuctionOpened {
    #[topic]
    pub workflow_root: BytesN<32>,
    #[topic]
    pub owner: Address,
    pub constraints_hash: BytesN<32>,
    pub minimum_bond: i128,
    pub commit_deadline_ledger: u32,
    pub reveal_deadline_ledger: u32,
}

#[contractevent(topics = ["bid_committed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BidCommitted {
    #[topic]
    pub workflow_root: BytesN<32>,
    #[topic]
    pub solver: Address,
    pub commitment: BytesN<32>,
}

#[contractevent(topics = ["bid_revealed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BidRevealed {
    #[topic]
    pub workflow_root: BytesN<32>,
    #[topic]
    pub solver: Address,
    pub route_hash: BytesN<32>,
    pub quote_evidence_hash: BytesN<32>,
    pub promised_output: i128,
    pub solver_fee: i128,
    pub eligible: bool,
}

#[contractevent(topics = ["auction_finalized"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuctionFinalized {
    #[topic]
    pub workflow_root: BytesN<32>,
    pub winner: Option<Address>,
    pub route_hash: Option<BytesN<32>>,
    pub net_output: Option<i128>,
}

#[contractevent(topics = ["auction_settled"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuctionSettled {
    #[topic]
    pub workflow_root: BytesN<32>,
    pub status: AuctionStatus,
    pub result_hash: BytesN<32>,
    pub bond_resolution_required: bool,
}

#[contractimpl]
impl KletiaRouteAuction {
    pub fn __constructor(
        env: Env,
        bond_vault: Address,
        settlement_authority: Address,
        max_bids: u32,
    ) -> Result<(), AuctionError> {
        if max_bids == 0 || max_bids > MAX_BIDS_HARD_LIMIT {
            return Err(AuctionError::InvalidConfig);
        }
        env.storage().instance().set(
            &DataKey::Config,
            &AuctionConfig {
                bond_vault,
                settlement_authority,
                max_bids,
            },
        );
        Ok(())
    }

    pub fn config(env: Env) -> Result<AuctionConfig, AuctionError> {
        read_config(&env)
    }

    pub fn get(env: Env, workflow_root: BytesN<32>) -> Option<AuctionRecord> {
        env.storage()
            .persistent()
            .get(&DataKey::Auction(workflow_root))
    }

    pub fn bid(env: Env, workflow_root: BytesN<32>, solver: Address) -> Option<BidRecord> {
        env.storage()
            .persistent()
            .get(&DataKey::Bid(workflow_root, solver))
    }

    pub fn bidders(env: Env, workflow_root: BytesN<32>) -> Vec<Address> {
        env.storage()
            .persistent()
            .get(&DataKey::Bidders(workflow_root))
            .unwrap_or(Vec::new(&env))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn open(
        env: Env,
        owner: Address,
        workflow_root: BytesN<32>,
        constraints_hash: BytesN<32>,
        minimum_output: i128,
        maximum_solver_fee: i128,
        maximum_duration_seconds: u64,
        minimum_bond: i128,
        commit_deadline_ledger: u32,
        reveal_deadline_ledger: u32,
        settlement_deadline_ledger: u32,
    ) -> Result<AuctionRecord, AuctionError> {
        owner.require_auth();
        require_hash(&workflow_root)?;
        require_hash(&constraints_hash)?;
        require_positive(minimum_output)?;
        if maximum_solver_fee < 0 || maximum_duration_seconds == 0 {
            return Err(AuctionError::InvalidAmount);
        }
        require_positive(minimum_bond)?;
        validate_deadlines(
            &env,
            commit_deadline_ledger,
            reveal_deadline_ledger,
            settlement_deadline_ledger,
        )?;
        let key = DataKey::Auction(workflow_root.clone());
        if env.storage().persistent().has(&key) {
            return Err(AuctionError::AuctionAlreadyExists);
        }
        let record = AuctionRecord {
            owner: owner.clone(),
            workflow_root: workflow_root.clone(),
            constraints_hash: constraints_hash.clone(),
            minimum_output,
            maximum_solver_fee,
            maximum_duration_seconds,
            minimum_bond,
            commit_deadline_ledger,
            reveal_deadline_ledger,
            settlement_deadline_ledger,
            bid_count: 0,
            status: AuctionStatus::Open,
            winner: None,
            winning_route_hash: None,
            winning_net_output: None,
            result_hash: None,
        };
        env.storage().persistent().set(&key, &record);
        env.storage().persistent().set(
            &DataKey::Bidders(workflow_root.clone()),
            &Vec::<Address>::new(&env),
        );
        extend_auction(&env, &workflow_root, settlement_deadline_ledger);
        AuctionOpened {
            workflow_root,
            owner,
            constraints_hash,
            minimum_bond,
            commit_deadline_ledger,
            reveal_deadline_ledger,
        }
        .publish(&env);
        Ok(record)
    }

    pub fn compute_commitment(
        env: Env,
        workflow_root: BytesN<32>,
        solver: Address,
        route_hash: BytesN<32>,
        quote_evidence_hash: BytesN<32>,
        promised_output: i128,
        solver_fee: i128,
        duration_seconds: u64,
        quote_expires_at_ledger: u32,
        salt: BytesN<32>,
    ) -> BytesN<32> {
        commitment(
            &env,
            workflow_root,
            solver,
            route_hash,
            quote_evidence_hash,
            promised_output,
            solver_fee,
            duration_seconds,
            quote_expires_at_ledger,
            salt,
        )
    }

    pub fn commit_bid(
        env: Env,
        solver: Address,
        workflow_root: BytesN<32>,
        commitment: BytesN<32>,
    ) -> Result<BidRecord, AuctionError> {
        solver.require_auth();
        require_hash(&commitment)?;
        let config = read_config(&env)?;
        let mut auction = read_auction(&env, &workflow_root)?;
        if auction.status != AuctionStatus::Open {
            return Err(AuctionError::AuctionNotOpen);
        }
        if env.ledger().sequence() > auction.commit_deadline_ledger {
            return Err(AuctionError::CommitWindowClosed);
        }
        if auction.bid_count >= config.max_bids {
            return Err(AuctionError::TooManyBids);
        }
        let bid_key = DataKey::Bid(workflow_root.clone(), solver.clone());
        if env.storage().persistent().has(&bid_key) {
            return Err(AuctionError::BidAlreadyExists);
        }
        validate_bond_lock(&env, &config, &auction, &solver)?;
        let bid = BidRecord {
            solver: solver.clone(),
            commitment: commitment.clone(),
            committed_at_ledger: env.ledger().sequence(),
            revealed_at_ledger: None,
            route_hash: None,
            quote_evidence_hash: None,
            promised_output: None,
            solver_fee: None,
            duration_seconds: None,
            quote_expires_at_ledger: None,
            eligible: false,
        };
        auction.bid_count = auction
            .bid_count
            .checked_add(1)
            .ok_or(AuctionError::ArithmeticOverflow)?;
        let mut bidders = Self::bidders(env.clone(), workflow_root.clone());
        bidders.push_back(solver.clone());
        env.storage().persistent().set(&bid_key, &bid);
        env.storage()
            .persistent()
            .set(&DataKey::Bidders(workflow_root.clone()), &bidders);
        env.storage()
            .persistent()
            .set(&DataKey::Auction(workflow_root.clone()), &auction);
        extend_bid(
            &env,
            &workflow_root,
            &solver,
            auction.settlement_deadline_ledger,
        );
        extend_auction(&env, &workflow_root, auction.settlement_deadline_ledger);
        BidCommitted {
            workflow_root,
            solver,
            commitment,
        }
        .publish(&env);
        Ok(bid)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn reveal_bid(
        env: Env,
        solver: Address,
        workflow_root: BytesN<32>,
        route_hash: BytesN<32>,
        quote_evidence_hash: BytesN<32>,
        promised_output: i128,
        solver_fee: i128,
        duration_seconds: u64,
        quote_expires_at_ledger: u32,
        salt: BytesN<32>,
    ) -> Result<BidRecord, AuctionError> {
        solver.require_auth();
        require_hash(&route_hash)?;
        require_hash(&quote_evidence_hash)?;
        require_hash(&salt)?;
        let auction = read_auction(&env, &workflow_root)?;
        if auction.status != AuctionStatus::Open {
            return Err(AuctionError::AuctionNotOpen);
        }
        let current = env.ledger().sequence();
        if current <= auction.commit_deadline_ledger || current > auction.reveal_deadline_ledger {
            return Err(AuctionError::RevealWindowClosed);
        }
        let bid_key = DataKey::Bid(workflow_root.clone(), solver.clone());
        let mut bid: BidRecord = env
            .storage()
            .persistent()
            .get(&bid_key)
            .ok_or(AuctionError::BidNotFound)?;
        if bid.revealed_at_ledger.is_some() {
            return Err(AuctionError::BidAlreadyRevealed);
        }
        let expected = commitment(
            &env,
            workflow_root.clone(),
            solver.clone(),
            route_hash.clone(),
            quote_evidence_hash.clone(),
            promised_output,
            solver_fee,
            duration_seconds,
            quote_expires_at_ledger,
            salt,
        );
        if expected != bid.commitment {
            return Err(AuctionError::InvalidCommitment);
        }
        let eligible = promised_output >= auction.minimum_output
            && solver_fee >= 0
            && solver_fee <= auction.maximum_solver_fee
            && duration_seconds > 0
            && duration_seconds <= auction.maximum_duration_seconds
            && quote_expires_at_ledger >= auction.reveal_deadline_ledger;
        bid.revealed_at_ledger = Some(current);
        bid.route_hash = Some(route_hash.clone());
        bid.quote_evidence_hash = Some(quote_evidence_hash.clone());
        bid.promised_output = Some(promised_output);
        bid.solver_fee = Some(solver_fee);
        bid.duration_seconds = Some(duration_seconds);
        bid.quote_expires_at_ledger = Some(quote_expires_at_ledger);
        bid.eligible = eligible;
        env.storage().persistent().set(&bid_key, &bid);
        extend_bid(
            &env,
            &workflow_root,
            &solver,
            auction.settlement_deadline_ledger,
        );
        BidRevealed {
            workflow_root,
            solver,
            route_hash,
            quote_evidence_hash,
            promised_output,
            solver_fee,
            eligible,
        }
        .publish(&env);
        Ok(bid)
    }

    pub fn finalize(env: Env, workflow_root: BytesN<32>) -> Result<AuctionRecord, AuctionError> {
        let config = read_config(&env)?;
        let mut auction = read_auction(&env, &workflow_root)?;
        if auction.status != AuctionStatus::Open {
            return Err(AuctionError::AuctionNotOpen);
        }
        let current = env.ledger().sequence();
        if current <= auction.reveal_deadline_ledger || current > auction.settlement_deadline_ledger
        {
            return Err(AuctionError::FinalizationWindowClosed);
        }
        let bidders = Self::bidders(env.clone(), workflow_root.clone());
        let mut winner: Option<BidRecord> = None;
        for solver in bidders.iter() {
            let bid = Self::bid(env.clone(), workflow_root.clone(), solver.clone());
            if let Some(candidate) = bid {
                if !candidate.eligible
                    || !bond_lock_valid(&env, &config, &auction, &candidate.solver)
                {
                    continue;
                }
                if candidate.quote_expires_at_ledger.unwrap_or(0) < current {
                    continue;
                }
                winner = choose_better(winner, candidate)?;
            }
        }
        if let Some(selected) = winner {
            let promised_output = selected
                .promised_output
                .ok_or(AuctionError::InvalidAmount)?;
            let solver_fee = selected.solver_fee.ok_or(AuctionError::InvalidAmount)?;
            let net_output = promised_output
                .checked_sub(solver_fee)
                .ok_or(AuctionError::ArithmeticOverflow)?;
            auction.status = AuctionStatus::Finalized;
            auction.winner = Some(selected.solver);
            auction.winning_route_hash = selected.route_hash;
            auction.winning_net_output = Some(net_output);
        } else {
            auction.status = AuctionStatus::NoWinner;
        }
        env.storage()
            .persistent()
            .set(&DataKey::Auction(workflow_root.clone()), &auction);
        extend_auction(&env, &workflow_root, auction.settlement_deadline_ledger);
        AuctionFinalized {
            workflow_root,
            winner: auction.winner.clone(),
            route_hash: auction.winning_route_hash.clone(),
            net_output: auction.winning_net_output,
        }
        .publish(&env);
        Ok(auction)
    }

    pub fn settle_success(
        env: Env,
        workflow_root: BytesN<32>,
        receipt_hash: BytesN<32>,
    ) -> Result<AuctionRecord, AuctionError> {
        settle(&env, workflow_root, receipt_hash, AuctionStatus::Succeeded)
    }

    pub fn settle_solver_fault(
        env: Env,
        workflow_root: BytesN<32>,
        evidence_hash: BytesN<32>,
    ) -> Result<AuctionRecord, AuctionError> {
        settle(
            &env,
            workflow_root,
            evidence_hash,
            AuctionStatus::SolverFault,
        )
    }

    pub fn mark_indeterminate(
        env: Env,
        workflow_root: BytesN<32>,
        recovery_hash: BytesN<32>,
    ) -> Result<AuctionRecord, AuctionError> {
        settle(
            &env,
            workflow_root,
            recovery_hash,
            AuctionStatus::Indeterminate,
        )
    }

    /// Closes an abandoned auction after its settlement window without
    /// assigning solver fault. Locked bonds remain protected by the vault's
    /// separate resolution grace and can then be reclaimed by their owners.
    pub fn expire_unsettled(
        env: Env,
        workflow_root: BytesN<32>,
        recovery_hash: BytesN<32>,
    ) -> Result<AuctionRecord, AuctionError> {
        require_hash(&recovery_hash)?;
        let mut auction = read_auction(&env, &workflow_root)?;
        if env.ledger().sequence() <= auction.settlement_deadline_ledger {
            return Err(AuctionError::SettlementWindowStillOpen);
        }
        auction.status = match auction.status {
            AuctionStatus::Open => AuctionStatus::NoWinner,
            AuctionStatus::Finalized => AuctionStatus::Indeterminate,
            _ => return Err(AuctionError::InvalidSettlementState),
        };
        auction.result_hash = Some(recovery_hash.clone());
        env.storage()
            .persistent()
            .set(&DataKey::Auction(workflow_root.clone()), &auction);
        AuctionSettled {
            workflow_root,
            status: auction.status,
            result_hash: recovery_hash,
            bond_resolution_required: false,
        }
        .publish(&env);
        Ok(auction)
    }

    pub fn cancel(
        env: Env,
        workflow_root: BytesN<32>,
        cancellation_hash: BytesN<32>,
    ) -> Result<AuctionRecord, AuctionError> {
        require_hash(&cancellation_hash)?;
        let mut auction = read_auction(&env, &workflow_root)?;
        auction.owner.require_auth();
        if auction.status != AuctionStatus::Open {
            return Err(AuctionError::AuctionNotOpen);
        }
        if auction.bid_count != 0 {
            return Err(AuctionError::AuctionHasBids);
        }
        auction.status = AuctionStatus::Cancelled;
        auction.result_hash = Some(cancellation_hash.clone());
        env.storage()
            .persistent()
            .set(&DataKey::Auction(workflow_root.clone()), &auction);
        AuctionSettled {
            workflow_root,
            status: AuctionStatus::Cancelled,
            result_hash: cancellation_hash,
            bond_resolution_required: false,
        }
        .publish(&env);
        Ok(auction)
    }
}

fn read_config(env: &Env) -> Result<AuctionConfig, AuctionError> {
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .ok_or(AuctionError::NotInitialized)
}

fn read_auction(env: &Env, workflow_root: &BytesN<32>) -> Result<AuctionRecord, AuctionError> {
    env.storage()
        .persistent()
        .get(&DataKey::Auction(workflow_root.clone()))
        .ok_or(AuctionError::AuctionNotFound)
}

fn validate_bond_lock(
    env: &Env,
    config: &AuctionConfig,
    auction: &AuctionRecord,
    solver: &Address,
) -> Result<(), AuctionError> {
    let lock = SolverBondVaultClient::new(env, &config.bond_vault)
        .bond_lock(solver, &auction.workflow_root)
        .ok_or(AuctionError::BondLockMissing)?;
    if lock.status != BondLockStatus::Locked || lock.amount < auction.minimum_bond {
        return Err(AuctionError::BondLockInsufficient);
    }
    if lock.expires_at_ledger < auction.settlement_deadline_ledger {
        return Err(AuctionError::BondLockExpiresEarly);
    }
    Ok(())
}

fn bond_lock_valid(
    env: &Env,
    config: &AuctionConfig,
    auction: &AuctionRecord,
    solver: &Address,
) -> bool {
    validate_bond_lock(env, config, auction, solver).is_ok()
}

#[allow(clippy::too_many_arguments)]
fn commitment(
    env: &Env,
    workflow_root: BytesN<32>,
    solver: Address,
    route_hash: BytesN<32>,
    quote_evidence_hash: BytesN<32>,
    promised_output: i128,
    solver_fee: i128,
    duration_seconds: u64,
    quote_expires_at_ledger: u32,
    salt: BytesN<32>,
) -> BytesN<32> {
    let domain: BytesN<32> = env
        .crypto()
        .sha256(&Bytes::from_slice(env, b"KLETIA_ROUTE_BID_V1"))
        .into();
    let preimage = BidCommitmentPreimage {
        domain_hash: domain,
        auction_contract: env.current_contract_address(),
        workflow_root,
        solver,
        route_hash,
        quote_evidence_hash,
        promised_output,
        solver_fee,
        duration_seconds,
        quote_expires_at_ledger,
        salt,
    };
    env.crypto().sha256(&preimage.to_xdr(env)).into()
}

fn choose_better(
    current: Option<BidRecord>,
    candidate: BidRecord,
) -> Result<Option<BidRecord>, AuctionError> {
    let Some(existing) = current else {
        return Ok(Some(candidate));
    };
    let existing_net = existing
        .promised_output
        .ok_or(AuctionError::InvalidAmount)?
        .checked_sub(existing.solver_fee.ok_or(AuctionError::InvalidAmount)?)
        .ok_or(AuctionError::ArithmeticOverflow)?;
    let candidate_net = candidate
        .promised_output
        .ok_or(AuctionError::InvalidAmount)?
        .checked_sub(candidate.solver_fee.ok_or(AuctionError::InvalidAmount)?)
        .ok_or(AuctionError::ArithmeticOverflow)?;
    if candidate_net > existing_net
        || (candidate_net == existing_net
            && candidate.duration_seconds.unwrap_or(u64::MAX)
                < existing.duration_seconds.unwrap_or(u64::MAX))
    {
        Ok(Some(candidate))
    } else {
        Ok(Some(existing))
    }
}

fn settle(
    env: &Env,
    workflow_root: BytesN<32>,
    result_hash: BytesN<32>,
    target_status: AuctionStatus,
) -> Result<AuctionRecord, AuctionError> {
    require_hash(&result_hash)?;
    let config = read_config(env)?;
    config.settlement_authority.require_auth();
    let mut auction = read_auction(env, &workflow_root)?;
    let recoverable = auction.status == AuctionStatus::Indeterminate
        && (target_status == AuctionStatus::Succeeded
            || target_status == AuctionStatus::SolverFault);
    if auction.status != AuctionStatus::Finalized && !recoverable {
        return Err(AuctionError::InvalidSettlementState);
    }
    if target_status != AuctionStatus::Succeeded
        && target_status != AuctionStatus::SolverFault
        && target_status != AuctionStatus::Indeterminate
    {
        return Err(AuctionError::InvalidSettlementState);
    }
    auction.status = target_status;
    auction.result_hash = Some(result_hash.clone());
    env.storage()
        .persistent()
        .set(&DataKey::Auction(workflow_root.clone()), &auction);
    extend_auction(env, &workflow_root, auction.settlement_deadline_ledger);
    AuctionSettled {
        workflow_root,
        status: target_status,
        result_hash,
        // The settlement authority must separately release or slash the
        // matching vault lock. Indeterminate outcomes never slash.
        bond_resolution_required: target_status != AuctionStatus::Indeterminate,
    }
    .publish(env);
    Ok(auction)
}

fn require_positive(value: i128) -> Result<(), AuctionError> {
    if value <= 0 {
        Err(AuctionError::InvalidAmount)
    } else {
        Ok(())
    }
}

fn require_hash(value: &BytesN<32>) -> Result<(), AuctionError> {
    if value.to_array().iter().all(|byte| *byte == 0) {
        Err(AuctionError::InvalidHash)
    } else {
        Ok(())
    }
}

fn validate_deadlines(
    env: &Env,
    commit_deadline: u32,
    reveal_deadline: u32,
    settlement_deadline: u32,
) -> Result<(), AuctionError> {
    let current = env.ledger().sequence();
    let maximum = current.saturating_add(env.storage().max_ttl());
    if commit_deadline <= current
        || reveal_deadline <= commit_deadline
        || settlement_deadline <= reveal_deadline
        || settlement_deadline > maximum
    {
        Err(AuctionError::InvalidDeadlines)
    } else {
        Ok(())
    }
}

fn extend_auction(env: &Env, workflow_root: &BytesN<32>, settlement_deadline: u32) {
    let current = env.ledger().sequence();
    let desired = settlement_deadline
        .saturating_sub(current)
        .saturating_add(512)
        .min(env.storage().max_ttl());
    env.storage().persistent().extend_ttl(
        &DataKey::Auction(workflow_root.clone()),
        desired / 2,
        desired,
    );
    env.storage().persistent().extend_ttl(
        &DataKey::Bidders(workflow_root.clone()),
        desired / 2,
        desired,
    );
}

fn extend_bid(env: &Env, workflow_root: &BytesN<32>, solver: &Address, deadline: u32) {
    let current = env.ledger().sequence();
    let desired = deadline
        .saturating_sub(current)
        .saturating_add(512)
        .min(env.storage().max_ttl());
    env.storage().persistent().extend_ttl(
        &DataKey::Bid(workflow_root.clone(), solver.clone()),
        desired / 2,
        desired,
    );
}

#[cfg(test)]
mod test;
