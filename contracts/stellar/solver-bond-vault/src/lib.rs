// SPDX-License-Identifier: MIT
#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, BytesN, Env,
};

#[contract]
pub struct KletiaSolverBondVault;

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SolverStatus {
    Active,
    Inactive,
    Suspended,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BondLockStatus {
    Locked,
    Released,
    Slashed,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultConfig {
    pub administrator: Address,
    pub coordinator: Address,
    pub treasury: Address,
    pub bond_asset: Address,
    pub minimum_bond: i128,
    pub resolution_grace_ledgers: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SolverPosition {
    pub solver: Address,
    pub metadata_hash: BytesN<32>,
    pub total_bond: i128,
    pub locked_bond: i128,
    pub status: SolverStatus,
    pub registered_at_ledger: u32,
    pub updated_at_ledger: u32,
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

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Config,
    Position(Address),
    BondLock(Address, BytesN<32>),
}

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum VaultError {
    NotInitialized = 1,
    AlreadyRegistered = 2,
    SolverNotFound = 3,
    SolverNotActive = 4,
    SolverSuspended = 5,
    InvalidAmount = 6,
    InvalidHash = 7,
    InsufficientUnlockedBond = 8,
    BondBelowMinimum = 9,
    LockAlreadyExists = 10,
    LockNotFound = 11,
    LockNotActive = 12,
    InvalidExpiry = 13,
    ActiveSolverCannotWithdraw = 14,
    LockedBondCannotWithdraw = 15,
    ArithmeticOverflow = 16,
    InvalidResolutionGrace = 17,
    LockNotReclaimable = 18,
}

#[contractevent(topics = ["solver_registered"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SolverRegistered {
    #[topic]
    pub solver: Address,
    pub metadata_hash: BytesN<32>,
    pub total_bond: i128,
}

#[contractevent(topics = ["bond_deposited"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BondDeposited {
    #[topic]
    pub solver: Address,
    pub amount: i128,
    pub total_bond: i128,
}

#[contractevent(topics = ["bond_withdrawn"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BondWithdrawn {
    #[topic]
    pub solver: Address,
    pub recipient: Address,
    pub amount: i128,
}

#[contractevent(topics = ["bond_locked"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BondLocked {
    #[topic]
    pub solver: Address,
    #[topic]
    pub workflow_root: BytesN<32>,
    pub amount: i128,
    pub expires_at_ledger: u32,
}

#[contractevent(topics = ["bond_released"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BondReleased {
    #[topic]
    pub solver: Address,
    #[topic]
    pub workflow_root: BytesN<32>,
    pub resolution_hash: BytesN<32>,
}

#[contractevent(topics = ["bond_slashed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BondSlashed {
    #[topic]
    pub solver: Address,
    #[topic]
    pub workflow_root: BytesN<32>,
    pub amount: i128,
    pub evidence_hash: BytesN<32>,
}

#[contractevent(topics = ["solver_status"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SolverStatusChanged {
    #[topic]
    pub solver: Address,
    pub status: SolverStatus,
}

#[contractimpl]
impl KletiaSolverBondVault {
    pub fn __constructor(
        env: Env,
        administrator: Address,
        coordinator: Address,
        treasury: Address,
        bond_asset: Address,
        minimum_bond: i128,
        resolution_grace_ledgers: u32,
    ) -> Result<(), VaultError> {
        require_positive(minimum_bond)?;
        if resolution_grace_ledgers == 0 || resolution_grace_ledgers > 120_960 {
            return Err(VaultError::InvalidResolutionGrace);
        }
        let config = VaultConfig {
            administrator,
            coordinator,
            treasury,
            bond_asset,
            minimum_bond,
            resolution_grace_ledgers,
        };
        env.storage().instance().set(&DataKey::Config, &config);
        Ok(())
    }

    pub fn config(env: Env) -> Result<VaultConfig, VaultError> {
        read_config(&env)
    }

    pub fn position(env: Env, solver: Address) -> Option<SolverPosition> {
        env.storage().persistent().get(&DataKey::Position(solver))
    }

    pub fn bond_lock(env: Env, solver: Address, workflow_root: BytesN<32>) -> Option<BondLock> {
        env.storage()
            .persistent()
            .get(&DataKey::BondLock(solver, workflow_root))
    }

    pub fn available_bond(env: Env, solver: Address) -> i128 {
        Self::position(env, solver)
            .map(|position| position.total_bond - position.locked_bond)
            .unwrap_or(0)
    }

    pub fn register(
        env: Env,
        solver: Address,
        metadata_hash: BytesN<32>,
        amount: i128,
    ) -> Result<SolverPosition, VaultError> {
        solver.require_auth();
        require_hash(&metadata_hash)?;
        let config = read_config(&env)?;
        if amount < config.minimum_bond {
            return Err(VaultError::BondBelowMinimum);
        }
        let key = DataKey::Position(solver.clone());
        if env.storage().persistent().has(&key) {
            return Err(VaultError::AlreadyRegistered);
        }
        let current = env.ledger().sequence();
        let position = SolverPosition {
            solver: solver.clone(),
            metadata_hash: metadata_hash.clone(),
            total_bond: amount,
            locked_bond: 0,
            status: SolverStatus::Active,
            registered_at_ledger: current,
            updated_at_ledger: current,
        };
        // Effects first. A failed token transfer rolls the invocation back.
        env.storage().persistent().set(&key, &position);
        extend_position(&env, &solver);
        token::Client::new(&env, &config.bond_asset).transfer(
            &solver,
            env.current_contract_address(),
            &amount,
        );
        SolverRegistered {
            solver,
            metadata_hash,
            total_bond: amount,
        }
        .publish(&env);
        Ok(position)
    }

    pub fn deposit(env: Env, solver: Address, amount: i128) -> Result<SolverPosition, VaultError> {
        solver.require_auth();
        require_positive(amount)?;
        let config = read_config(&env)?;
        let key = DataKey::Position(solver.clone());
        let mut position: SolverPosition = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(VaultError::SolverNotFound)?;
        position.total_bond = position
            .total_bond
            .checked_add(amount)
            .ok_or(VaultError::ArithmeticOverflow)?;
        position.updated_at_ledger = env.ledger().sequence();
        env.storage().persistent().set(&key, &position);
        extend_position(&env, &solver);
        token::Client::new(&env, &config.bond_asset).transfer(
            &solver,
            env.current_contract_address(),
            &amount,
        );
        BondDeposited {
            solver,
            amount,
            total_bond: position.total_bond,
        }
        .publish(&env);
        Ok(position)
    }

    pub fn set_active(
        env: Env,
        solver: Address,
        active: bool,
    ) -> Result<SolverPosition, VaultError> {
        solver.require_auth();
        let config = read_config(&env)?;
        let key = DataKey::Position(solver.clone());
        let mut position: SolverPosition = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(VaultError::SolverNotFound)?;
        if position.status == SolverStatus::Suspended {
            return Err(VaultError::SolverSuspended);
        }
        if active && position.total_bond - position.locked_bond < config.minimum_bond {
            return Err(VaultError::BondBelowMinimum);
        }
        position.status = if active {
            SolverStatus::Active
        } else {
            SolverStatus::Inactive
        };
        position.updated_at_ledger = env.ledger().sequence();
        env.storage().persistent().set(&key, &position);
        extend_position(&env, &solver);
        SolverStatusChanged {
            solver,
            status: position.status,
        }
        .publish(&env);
        Ok(position)
    }

    pub fn set_suspended(
        env: Env,
        solver: Address,
        suspended: bool,
    ) -> Result<SolverPosition, VaultError> {
        let config = read_config(&env)?;
        config.administrator.require_auth();
        let key = DataKey::Position(solver.clone());
        let mut position: SolverPosition = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(VaultError::SolverNotFound)?;
        position.status = if suspended {
            SolverStatus::Suspended
        } else {
            SolverStatus::Inactive
        };
        position.updated_at_ledger = env.ledger().sequence();
        env.storage().persistent().set(&key, &position);
        extend_position(&env, &solver);
        SolverStatusChanged {
            solver,
            status: position.status,
        }
        .publish(&env);
        Ok(position)
    }

    pub fn withdraw(
        env: Env,
        solver: Address,
        recipient: Address,
        amount: i128,
    ) -> Result<SolverPosition, VaultError> {
        solver.require_auth();
        require_positive(amount)?;
        let config = read_config(&env)?;
        let key = DataKey::Position(solver.clone());
        let mut position: SolverPosition = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(VaultError::SolverNotFound)?;
        if position.status == SolverStatus::Active {
            return Err(VaultError::ActiveSolverCannotWithdraw);
        }
        if position.locked_bond != 0 {
            return Err(VaultError::LockedBondCannotWithdraw);
        }
        if amount > position.total_bond {
            return Err(VaultError::InsufficientUnlockedBond);
        }
        position.total_bond -= amount;
        position.updated_at_ledger = env.ledger().sequence();
        env.storage().persistent().set(&key, &position);
        extend_position(&env, &solver);
        token::Client::new(&env, &config.bond_asset).transfer(
            &env.current_contract_address(),
            &recipient,
            &amount,
        );
        BondWithdrawn {
            solver,
            recipient,
            amount,
        }
        .publish(&env);
        Ok(position)
    }

    pub fn lock(
        env: Env,
        solver: Address,
        workflow_root: BytesN<32>,
        amount: i128,
        expires_at_ledger: u32,
    ) -> Result<BondLock, VaultError> {
        solver.require_auth();
        require_hash(&workflow_root)?;
        require_positive(amount)?;
        let current = env.ledger().sequence();
        let config = read_config(&env)?;
        let reclaim_after_ledger = expires_at_ledger
            .checked_add(config.resolution_grace_ledgers)
            .ok_or(VaultError::ArithmeticOverflow)?;
        validate_expiry(&env, current, reclaim_after_ledger)?;
        let position_key = DataKey::Position(solver.clone());
        let mut position: SolverPosition = env
            .storage()
            .persistent()
            .get(&position_key)
            .ok_or(VaultError::SolverNotFound)?;
        if position.status != SolverStatus::Active {
            return Err(if position.status == SolverStatus::Suspended {
                VaultError::SolverSuspended
            } else {
                VaultError::SolverNotActive
            });
        }
        let available = position.total_bond - position.locked_bond;
        if amount > available {
            return Err(VaultError::InsufficientUnlockedBond);
        }
        let lock_key = DataKey::BondLock(solver.clone(), workflow_root.clone());
        if env.storage().persistent().has(&lock_key) {
            return Err(VaultError::LockAlreadyExists);
        }
        position.locked_bond = position
            .locked_bond
            .checked_add(amount)
            .ok_or(VaultError::ArithmeticOverflow)?;
        position.updated_at_ledger = current;
        let bond_lock = BondLock {
            solver: solver.clone(),
            workflow_root: workflow_root.clone(),
            amount,
            status: BondLockStatus::Locked,
            created_at_ledger: current,
            expires_at_ledger,
            reclaim_after_ledger,
            resolution_hash: None,
        };
        env.storage().persistent().set(&position_key, &position);
        env.storage().persistent().set(&lock_key, &bond_lock);
        extend_position(&env, &solver);
        extend_lock(&env, &solver, &workflow_root, reclaim_after_ledger);
        BondLocked {
            solver,
            workflow_root,
            amount,
            expires_at_ledger,
        }
        .publish(&env);
        Ok(bond_lock)
    }

    pub fn release(
        env: Env,
        solver: Address,
        workflow_root: BytesN<32>,
        resolution_hash: BytesN<32>,
    ) -> Result<BondLock, VaultError> {
        require_hash(&resolution_hash)?;
        let config = read_config(&env)?;
        config.coordinator.require_auth();
        let bond_lock = resolve_lock(
            &env,
            solver.clone(),
            workflow_root.clone(),
            BondLockStatus::Released,
            resolution_hash.clone(),
        )?;
        BondReleased {
            solver,
            workflow_root,
            resolution_hash,
        }
        .publish(&env);
        Ok(bond_lock)
    }

    /// Lets a solver recover a still-locked bond after the advertised
    /// settlement window and immutable resolution grace have both elapsed.
    /// This is a liveness escape hatch, not a statement that foreign-chain
    /// execution succeeded. The solver cannot reclaim before the grace
    /// deadline and cannot replay a lock already released or slashed.
    pub fn reclaim_expired(
        env: Env,
        solver: Address,
        workflow_root: BytesN<32>,
        recovery_hash: BytesN<32>,
    ) -> Result<BondLock, VaultError> {
        solver.require_auth();
        require_hash(&recovery_hash)?;
        let lock_key = DataKey::BondLock(solver.clone(), workflow_root.clone());
        let bond_lock: BondLock = env
            .storage()
            .persistent()
            .get(&lock_key)
            .ok_or(VaultError::LockNotFound)?;
        if bond_lock.status != BondLockStatus::Locked {
            return Err(VaultError::LockNotActive);
        }
        if env.ledger().sequence() <= bond_lock.reclaim_after_ledger {
            return Err(VaultError::LockNotReclaimable);
        }
        let resolved = resolve_lock(
            &env,
            solver.clone(),
            workflow_root.clone(),
            BondLockStatus::Released,
            recovery_hash.clone(),
        )?;
        BondReleased {
            solver,
            workflow_root,
            resolution_hash: recovery_hash,
        }
        .publish(&env);
        Ok(resolved)
    }

    pub fn slash(
        env: Env,
        solver: Address,
        workflow_root: BytesN<32>,
        evidence_hash: BytesN<32>,
    ) -> Result<BondLock, VaultError> {
        require_hash(&evidence_hash)?;
        let config = read_config(&env)?;
        config.coordinator.require_auth();
        let bond_lock = resolve_lock(
            &env,
            solver.clone(),
            workflow_root.clone(),
            BondLockStatus::Slashed,
            evidence_hash.clone(),
        )?;
        let position_key = DataKey::Position(solver.clone());
        let mut position: SolverPosition = env
            .storage()
            .persistent()
            .get(&position_key)
            .ok_or(VaultError::SolverNotFound)?;
        position.total_bond -= bond_lock.amount;
        if position.total_bond < config.minimum_bond {
            position.status = SolverStatus::Inactive;
        }
        position.updated_at_ledger = env.ledger().sequence();
        env.storage().persistent().set(&position_key, &position);
        token::Client::new(&env, &config.bond_asset).transfer(
            &env.current_contract_address(),
            &config.treasury,
            &bond_lock.amount,
        );
        BondSlashed {
            solver,
            workflow_root,
            amount: bond_lock.amount,
            evidence_hash,
        }
        .publish(&env);
        Ok(bond_lock)
    }
}

fn read_config(env: &Env) -> Result<VaultConfig, VaultError> {
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .ok_or(VaultError::NotInitialized)
}

fn resolve_lock(
    env: &Env,
    solver: Address,
    workflow_root: BytesN<32>,
    status: BondLockStatus,
    resolution_hash: BytesN<32>,
) -> Result<BondLock, VaultError> {
    let lock_key = DataKey::BondLock(solver.clone(), workflow_root.clone());
    let mut bond_lock: BondLock = env
        .storage()
        .persistent()
        .get(&lock_key)
        .ok_or(VaultError::LockNotFound)?;
    if bond_lock.status != BondLockStatus::Locked {
        return Err(VaultError::LockNotActive);
    }
    let position_key = DataKey::Position(solver.clone());
    let mut position: SolverPosition = env
        .storage()
        .persistent()
        .get(&position_key)
        .ok_or(VaultError::SolverNotFound)?;
    if bond_lock.amount > position.locked_bond {
        return Err(VaultError::ArithmeticOverflow);
    }
    position.locked_bond -= bond_lock.amount;
    position.updated_at_ledger = env.ledger().sequence();
    bond_lock.status = status;
    bond_lock.resolution_hash = Some(resolution_hash);
    env.storage().persistent().set(&position_key, &position);
    env.storage().persistent().set(&lock_key, &bond_lock);
    extend_position(env, &solver);
    extend_lock(env, &solver, &workflow_root, bond_lock.reclaim_after_ledger);
    Ok(bond_lock)
}

fn require_positive(amount: i128) -> Result<(), VaultError> {
    if amount <= 0 {
        Err(VaultError::InvalidAmount)
    } else {
        Ok(())
    }
}

fn require_hash(value: &BytesN<32>) -> Result<(), VaultError> {
    if value.to_array().iter().all(|byte| *byte == 0) {
        Err(VaultError::InvalidHash)
    } else {
        Ok(())
    }
}

fn validate_expiry(env: &Env, current: u32, expires_at_ledger: u32) -> Result<(), VaultError> {
    let max_live_until = current.saturating_add(env.storage().max_ttl());
    if expires_at_ledger <= current || expires_at_ledger > max_live_until {
        Err(VaultError::InvalidExpiry)
    } else {
        Ok(())
    }
}

fn extend_position(env: &Env, solver: &Address) {
    let extend_to = env.storage().max_ttl();
    env.storage().persistent().extend_ttl(
        &DataKey::Position(solver.clone()),
        extend_to / 2,
        extend_to,
    );
}

fn extend_lock(env: &Env, solver: &Address, workflow_root: &BytesN<32>, expires: u32) {
    let current = env.ledger().sequence();
    let desired = expires.saturating_sub(current).saturating_add(512);
    let extend_to = desired.min(env.storage().max_ttl());
    env.storage().persistent().extend_ttl(
        &DataKey::BondLock(solver.clone(), workflow_root.clone()),
        extend_to / 2,
        extend_to,
    );
}

#[cfg(test)]
mod test;
