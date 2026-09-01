// SPDX-License-Identifier: MIT
#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, BytesN, Env,
};

#[contract]
pub struct KletiaPolicyReceiptRegistry;

/// Lifecycle state of an immutable policy commitment.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RecordStatus {
    Active,
    Finalized,
    Cancelled,
}

/// Ledger-relative view of a record's effective lifecycle.
///
/// `ExecutionExpiredAwaitingReceipt` is deliberately not an execution-capable
/// state. It only keeps the owner-authorized receipt-close path open after the
/// policy can no longer authorize new work.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EffectiveStatus {
    Active,
    ExecutionExpiredAwaitingReceipt,
    ReceiptWindowClosed,
    Finalized,
    Cancelled,
}

/// Public commitment metadata. Hash preimages are deliberately not stored.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PolicyRecord {
    pub owner: Address,
    pub nonce: u64,
    pub manifest_hash: BytesN<32>,
    pub privacy_budget_hash: BytesN<32>,
    pub receipt_hash: Option<BytesN<32>>,
    pub status: RecordStatus,
    pub committed_at_ledger: u32,
    /// Exclusive execution-validity boundary. No execution may rely on this
    /// policy at or after this ledger.
    pub execution_expires_at_ledger: u32,
    /// Exclusive owner-acknowledged receipt-close boundary. Finalization may
    /// continue after execution expiry, but not at or after this ledger.
    pub receipt_close_by_ledger: u32,
    pub updated_at_ledger: u32,
    /// Minimum requested persistence horizon. This is not a deletion boundary
    /// and does not extend policy validity.
    pub retention_floor_ledger: u32,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    NextNonce(Address),
    Record(Address, u64),
}

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum RegistryError {
    InvalidNonce = 1,
    NonceExhausted = 2,
    InvalidExpiry = 3,
    BeyondMaximumTtl = 4,
    RecordAlreadyExists = 5,
    RecordNotFound = 6,
    RecordNotActive = 7,
    PolicyExpired = 8,
    InvalidRetention = 9,
    InvalidHash = 10,
    InvalidReceiptDeadline = 11,
    ReceiptWindowClosed = 12,
}

#[contractevent(topics = ["policy_committed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PolicyCommitted {
    #[topic]
    pub owner: Address,
    #[topic]
    pub nonce: u64,
    pub manifest_hash: BytesN<32>,
    pub privacy_budget_hash: BytesN<32>,
    pub execution_expires_at_ledger: u32,
    pub receipt_close_by_ledger: u32,
    pub retention_floor_ledger: u32,
}

#[contractevent(topics = ["policy_finalized"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PolicyFinalized {
    #[topic]
    pub owner: Address,
    #[topic]
    pub nonce: u64,
    pub receipt_hash: BytesN<32>,
    pub finalized_at_ledger: u32,
}

#[contractevent(topics = ["policy_cancelled"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PolicyCancelled {
    #[topic]
    pub owner: Address,
    #[topic]
    pub nonce: u64,
    pub cancelled_at_ledger: u32,
}

#[contractevent(topics = ["ttl_extended"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TtlExtended {
    #[topic]
    pub owner: Address,
    #[topic]
    pub nonce: u64,
    pub retention_floor_ledger: u32,
}

#[contractimpl]
impl KletiaPolicyReceiptRegistry {
    /// Returns the next exact nonce the owner must use. The first nonce is zero.
    pub fn next_nonce(env: Env, owner: Address) -> u64 {
        env.storage()
            .persistent()
            .get(&DataKey::NextNonce(owner))
            .unwrap_or(0)
    }

    /// Returns a previously committed record, if it is still retained.
    pub fn get(env: Env, owner: Address, nonce: u64) -> Option<PolicyRecord> {
        env.storage()
            .persistent()
            .get(&DataKey::Record(owner, nonce))
    }

    /// Returns the ledger-relative lifecycle view for a retained record.
    pub fn effective_status(env: Env, owner: Address, nonce: u64) -> Option<EffectiveStatus> {
        Self::get(env.clone(), owner, nonce)
            .map(|record| effective_status_at(&record, env.ledger().sequence()))
    }

    /// Reports whether execution remains authorized by the policy lifecycle.
    pub fn is_active(env: Env, owner: Address, nonce: u64) -> bool {
        Self::effective_status(env, owner, nonce) == Some(EffectiveStatus::Active)
    }

    /// Reports whether the owner may bind a terminal opaque receipt hash.
    ///
    /// This can remain true after `is_active` becomes false. It never restores
    /// execution validity or grants authority over funds.
    pub fn can_finalize(env: Env, owner: Address, nonce: u64) -> bool {
        Self::get(env.clone(), owner, nonce)
            .map(|record| {
                record.status == RecordStatus::Active
                    && env.ledger().sequence() < record.receipt_close_by_ledger
            })
            .unwrap_or(false)
    }

    /// Commits opaque hashes for a user-approved policy and privacy budget.
    ///
    /// This method stores no funds, approvals, delegated authority, plaintext
    /// policy fields, or external-chain evidence.
    #[allow(clippy::too_many_arguments)]
    pub fn commit(
        env: Env,
        owner: Address,
        nonce: u64,
        manifest_hash: BytesN<32>,
        privacy_budget_hash: BytesN<32>,
        execution_expires_at_ledger: u32,
        receipt_close_by_ledger: u32,
        retention_floor_ledger: u32,
    ) -> Result<PolicyRecord, RegistryError> {
        owner.require_auth();
        require_nonzero_hash(&manifest_hash)?;
        require_nonzero_hash(&privacy_budget_hash)?;

        let current_ledger = env.ledger().sequence();
        validate_future_ledger(&env, execution_expires_at_ledger, current_ledger)?;
        if receipt_close_by_ledger <= execution_expires_at_ledger {
            return Err(RegistryError::InvalidReceiptDeadline);
        }
        validate_receipt_deadline(&env, receipt_close_by_ledger, current_ledger)?;

        if retention_floor_ledger < receipt_close_by_ledger {
            return Err(RegistryError::InvalidRetention);
        }
        retention_ttl(&env, retention_floor_ledger, current_ledger)?;

        let nonce_key = DataKey::NextNonce(owner.clone());
        let expected_nonce = env
            .storage()
            .persistent()
            .get::<_, u64>(&nonce_key)
            .unwrap_or(0);
        if nonce != expected_nonce {
            return Err(RegistryError::InvalidNonce);
        }
        let next_nonce = nonce.checked_add(1).ok_or(RegistryError::NonceExhausted)?;

        let record_key = DataKey::Record(owner.clone(), nonce);
        if env.storage().persistent().has(&record_key) {
            return Err(RegistryError::RecordAlreadyExists);
        }

        let record = PolicyRecord {
            owner: owner.clone(),
            nonce,
            manifest_hash: manifest_hash.clone(),
            privacy_budget_hash: privacy_budget_hash.clone(),
            receipt_hash: None,
            status: RecordStatus::Active,
            committed_at_ledger: current_ledger,
            execution_expires_at_ledger,
            receipt_close_by_ledger,
            updated_at_ledger: current_ledger,
            retention_floor_ledger,
        };

        env.storage().persistent().set(&record_key, &record);
        env.storage().persistent().set(&nonce_key, &next_nonce);
        extend_storage(&env, &owner, nonce, retention_floor_ledger)?;

        PolicyCommitted {
            owner,
            nonce,
            manifest_hash,
            privacy_budget_hash,
            execution_expires_at_ledger,
            receipt_close_by_ledger,
            retention_floor_ledger,
        }
        .publish(&env);

        Ok(record)
    }

    /// Binds one opaque receipt hash before the receipt-close deadline.
    ///
    /// Finalization means only that `owner` authorized this hash. It does not
    /// validate the receipt preimage or prove any Stellar/EVM/CCTP outcome.
    /// Finalization after execution expiry cannot reactivate the policy or
    /// authorize any new work.
    pub fn finalize(
        env: Env,
        owner: Address,
        nonce: u64,
        receipt_hash: BytesN<32>,
    ) -> Result<PolicyRecord, RegistryError> {
        owner.require_auth();
        require_nonzero_hash(&receipt_hash)?;

        let current_ledger = env.ledger().sequence();
        let mut record = load_record(&env, &owner, nonce)?;
        require_receipt_window_open(&record, current_ledger)?;

        record.status = RecordStatus::Finalized;
        record.receipt_hash = Some(receipt_hash.clone());
        record.updated_at_ledger = current_ledger;
        env.storage()
            .persistent()
            .set(&DataKey::Record(owner.clone(), nonce), &record);
        extend_storage(&env, &owner, nonce, record.retention_floor_ledger)?;

        PolicyFinalized {
            owner,
            nonce,
            receipt_hash,
            finalized_at_ledger: current_ledger,
        }
        .publish(&env);

        Ok(record)
    }

    /// Cancels an execution-active policy without releasing or moving funds.
    pub fn cancel(env: Env, owner: Address, nonce: u64) -> Result<PolicyRecord, RegistryError> {
        owner.require_auth();

        let current_ledger = env.ledger().sequence();
        let mut record = load_record(&env, &owner, nonce)?;
        require_execution_active(&record, current_ledger)?;

        record.status = RecordStatus::Cancelled;
        record.updated_at_ledger = current_ledger;
        env.storage()
            .persistent()
            .set(&DataKey::Record(owner.clone(), nonce), &record);
        extend_storage(&env, &owner, nonce, record.retention_floor_ledger)?;

        PolicyCancelled {
            owner,
            nonce,
            cancelled_at_ledger: current_ledger,
        }
        .publish(&env);

        Ok(record)
    }

    /// Extends record retention only. It never changes policy expiry or status.
    ///
    /// This may be called for terminal or expired records while their persistent
    /// entries remain available. An archived entry must first be restored using
    /// Stellar's normal ledger-footprint restoration flow.
    pub fn extend_ttl(
        env: Env,
        owner: Address,
        nonce: u64,
        retention_floor_ledger: u32,
    ) -> Result<PolicyRecord, RegistryError> {
        owner.require_auth();

        let current_ledger = env.ledger().sequence();
        let mut record = load_record(&env, &owner, nonce)?;
        if retention_floor_ledger <= record.retention_floor_ledger
            || retention_floor_ledger < record.receipt_close_by_ledger
        {
            return Err(RegistryError::InvalidRetention);
        }
        retention_ttl(&env, retention_floor_ledger, current_ledger)?;

        record.retention_floor_ledger = retention_floor_ledger;
        record.updated_at_ledger = current_ledger;
        env.storage()
            .persistent()
            .set(&DataKey::Record(owner.clone(), nonce), &record);
        extend_storage(&env, &owner, nonce, retention_floor_ledger)?;

        TtlExtended {
            owner,
            nonce,
            retention_floor_ledger,
        }
        .publish(&env);

        Ok(record)
    }
}

fn load_record(env: &Env, owner: &Address, nonce: u64) -> Result<PolicyRecord, RegistryError> {
    env.storage()
        .persistent()
        .get(&DataKey::Record(owner.clone(), nonce))
        .ok_or(RegistryError::RecordNotFound)
}

fn effective_status_at(record: &PolicyRecord, current_ledger: u32) -> EffectiveStatus {
    match record.status {
        RecordStatus::Finalized => EffectiveStatus::Finalized,
        RecordStatus::Cancelled => EffectiveStatus::Cancelled,
        RecordStatus::Active if current_ledger < record.execution_expires_at_ledger => {
            EffectiveStatus::Active
        }
        RecordStatus::Active if current_ledger < record.receipt_close_by_ledger => {
            EffectiveStatus::ExecutionExpiredAwaitingReceipt
        }
        RecordStatus::Active => EffectiveStatus::ReceiptWindowClosed,
    }
}

fn require_execution_active(
    record: &PolicyRecord,
    current_ledger: u32,
) -> Result<(), RegistryError> {
    if record.status != RecordStatus::Active {
        return Err(RegistryError::RecordNotActive);
    }
    if current_ledger >= record.execution_expires_at_ledger {
        return Err(RegistryError::PolicyExpired);
    }
    Ok(())
}

fn require_receipt_window_open(
    record: &PolicyRecord,
    current_ledger: u32,
) -> Result<(), RegistryError> {
    if record.status != RecordStatus::Active {
        return Err(RegistryError::RecordNotActive);
    }
    if current_ledger >= record.receipt_close_by_ledger {
        return Err(RegistryError::ReceiptWindowClosed);
    }
    Ok(())
}

fn require_nonzero_hash(hash: &BytesN<32>) -> Result<(), RegistryError> {
    if hash.to_array() == [0_u8; 32] {
        return Err(RegistryError::InvalidHash);
    }
    Ok(())
}

fn validate_future_ledger(
    env: &Env,
    ledger: u32,
    current_ledger: u32,
) -> Result<(), RegistryError> {
    if ledger <= current_ledger {
        return Err(RegistryError::InvalidExpiry);
    }
    retention_ttl(env, ledger, current_ledger).map(|_| ())
}

fn validate_receipt_deadline(
    env: &Env,
    ledger: u32,
    current_ledger: u32,
) -> Result<(), RegistryError> {
    if ledger <= current_ledger {
        return Err(RegistryError::InvalidReceiptDeadline);
    }
    retention_ttl(env, ledger, current_ledger)
        .map(|_| ())
        .map_err(|error| match error {
            RegistryError::BeyondMaximumTtl => RegistryError::BeyondMaximumTtl,
            _ => RegistryError::InvalidReceiptDeadline,
        })
}

fn retention_ttl(
    env: &Env,
    retention_floor_ledger: u32,
    current_ledger: u32,
) -> Result<u32, RegistryError> {
    let ttl = retention_floor_ledger
        .checked_sub(current_ledger)
        .ok_or(RegistryError::InvalidRetention)?;
    if ttl == 0 {
        return Err(RegistryError::InvalidRetention);
    }
    if ttl > env.storage().max_ttl() {
        return Err(RegistryError::BeyondMaximumTtl);
    }
    Ok(ttl)
}

fn extend_storage(
    env: &Env,
    owner: &Address,
    nonce: u64,
    retention_floor_ledger: u32,
) -> Result<(), RegistryError> {
    let ttl = retention_ttl(env, retention_floor_ledger, env.ledger().sequence())?;
    let record_key = DataKey::Record(owner.clone(), nonce);
    let nonce_key = DataKey::NextNonce(owner.clone());

    env.storage().persistent().extend_ttl(&record_key, ttl, ttl);
    env.storage().persistent().extend_ttl(&nonce_key, ttl, ttl);
    env.storage().instance().extend_ttl(ttl, ttl);
    Ok(())
}

#[cfg(test)]
mod test;
