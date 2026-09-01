// SPDX-License-Identifier: MIT
#![no_std]

use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype, Address,
    Bytes, BytesN, Env, Vec,
};

#[contractclient(name = "PolicyVerifierRegistryClient")]
pub trait PolicyVerifierRegistry {
    fn verify(env: Env, version: u32, public_inputs: Vec<BytesN<32>>, proof: Bytes) -> bool;
}

#[contract]
pub struct KletiaIntentControlPlaneV2;

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EnvironmentLane {
    Production,
    Testnet,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkflowStatus {
    Active,
    Finalized,
    Cancelled,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkflowRecordV2 {
    pub owner: Address,
    pub nonce: u64,
    pub workflow_root: BytesN<32>,
    pub policy_root: BytesN<32>,
    pub protocol_registry_root: BytesN<32>,
    pub asset_registry_root: BytesN<32>,
    pub recipient_policy_root: BytesN<32>,
    pub selected_protocol_leaf: BytesN<32>,
    pub selected_asset_leaf: BytesN<32>,
    pub selected_recipient_leaf: BytesN<32>,
    pub nullifier: BytesN<32>,
    pub execution_context_commitment: BytesN<32>,
    pub verifier_version: u32,
    pub public_inputs_hash: BytesN<32>,
    pub lane: EnvironmentLane,
    pub status: WorkflowStatus,
    pub receipt_root: Option<BytesN<32>>,
    pub committed_at_ledger: u32,
    pub execution_expires_at_ledger: u32,
    pub receipt_close_by_ledger: u32,
    pub retention_floor_ledger: u32,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    VerifierRegistry,
    NextNonce(Address),
    Workflow(Address, u64),
    Nullifier(BytesN<32>),
}

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum ControlPlaneV2Error {
    InvalidNonce = 1,
    NonceExhausted = 2,
    InvalidHash = 3,
    InvalidExpiry = 4,
    InvalidReceiptDeadline = 5,
    InvalidRetention = 6,
    BeyondMaximumTtl = 7,
    WorkflowAlreadyExists = 8,
    WorkflowNotFound = 9,
    WorkflowNotActive = 10,
    NullifierAlreadyUsed = 11,
    ReceiptWindowClosed = 12,
    NotInitialized = 13,
    InvalidVerifierVersion = 14,
    InvalidProof = 15,
    PolicyProofRejected = 16,
}

#[contractevent(topics = ["workflow_v2_committed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkflowV2Committed {
    #[topic]
    pub owner: Address,
    #[topic]
    pub nonce: u64,
    pub workflow_root: BytesN<32>,
    pub policy_root: BytesN<32>,
    pub selected_protocol_leaf: BytesN<32>,
    pub selected_asset_leaf: BytesN<32>,
    pub selected_recipient_leaf: BytesN<32>,
    pub nullifier: BytesN<32>,
    pub verifier_version: u32,
    pub public_inputs_hash: BytesN<32>,
    pub lane: EnvironmentLane,
    pub execution_expires_at_ledger: u32,
    pub receipt_close_by_ledger: u32,
}

#[contractevent(topics = ["workflow_v2_finalized"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkflowV2Finalized {
    #[topic]
    pub owner: Address,
    #[topic]
    pub nonce: u64,
    pub receipt_root: BytesN<32>,
    pub finalized_at_ledger: u32,
}

#[contractevent(topics = ["workflow_v2_cancelled"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkflowV2Cancelled {
    #[topic]
    pub owner: Address,
    #[topic]
    pub nonce: u64,
    pub cancelled_at_ledger: u32,
}

#[contractimpl]
impl KletiaIntentControlPlaneV2 {
    pub fn __constructor(env: Env, verifier_registry: Address) {
        env.storage()
            .instance()
            .set(&DataKey::VerifierRegistry, &verifier_registry);
    }

    pub fn verifier_registry(env: Env) -> Result<Address, ControlPlaneV2Error> {
        env.storage()
            .instance()
            .get(&DataKey::VerifierRegistry)
            .ok_or(ControlPlaneV2Error::NotInitialized)
    }

    pub fn next_nonce(env: Env, owner: Address) -> u64 {
        env.storage()
            .persistent()
            .get(&DataKey::NextNonce(owner))
            .unwrap_or(0)
    }

    pub fn get(env: Env, owner: Address, nonce: u64) -> Option<WorkflowRecordV2> {
        env.storage()
            .persistent()
            .get(&DataKey::Workflow(owner, nonce))
    }

    pub fn nullifier_used(env: Env, nullifier: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Nullifier(nullifier))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn commit(
        env: Env,
        owner: Address,
        nonce: u64,
        workflow_root: BytesN<32>,
        policy_root: BytesN<32>,
        protocol_registry_root: BytesN<32>,
        asset_registry_root: BytesN<32>,
        recipient_policy_root: BytesN<32>,
        selected_protocol_leaf: BytesN<32>,
        selected_asset_leaf: BytesN<32>,
        selected_recipient_leaf: BytesN<32>,
        nullifier: BytesN<32>,
        execution_context_commitment: BytesN<32>,
        lane: EnvironmentLane,
        execution_expires_at_ledger: u32,
        receipt_close_by_ledger: u32,
        retention_floor_ledger: u32,
        verifier_version: u32,
        proof: Bytes,
    ) -> Result<WorkflowRecordV2, ControlPlaneV2Error> {
        owner.require_auth();
        for value in [
            &workflow_root,
            &policy_root,
            &protocol_registry_root,
            &asset_registry_root,
            &recipient_policy_root,
            &selected_protocol_leaf,
            &selected_asset_leaf,
            &selected_recipient_leaf,
            &nullifier,
            &execution_context_commitment,
        ] {
            require_hash(value)?;
        }
        if verifier_version == 0 {
            return Err(ControlPlaneV2Error::InvalidVerifierVersion);
        }
        if proof.is_empty() || proof.len() > 16_384 {
            return Err(ControlPlaneV2Error::InvalidProof);
        }
        let current = env.ledger().sequence();
        validate_deadlines(
            &env,
            current,
            execution_expires_at_ledger,
            receipt_close_by_ledger,
            retention_floor_ledger,
        )?;

        let lane_scalar = u32_scalar(
            &env,
            match lane {
                EnvironmentLane::Production => 0,
                EnvironmentLane::Testnet => 1,
            },
        );
        let mut public_inputs = Vec::new(&env);
        for input in [
            workflow_root.clone(),
            policy_root.clone(),
            protocol_registry_root.clone(),
            asset_registry_root.clone(),
            recipient_policy_root.clone(),
            selected_protocol_leaf.clone(),
            selected_asset_leaf.clone(),
            selected_recipient_leaf.clone(),
            lane_scalar,
            u32_scalar(&env, execution_expires_at_ledger),
            nullifier.clone(),
            execution_context_commitment.clone(),
        ] {
            public_inputs.push_back(input);
        }
        let mut encoded_inputs = Bytes::new(&env);
        for input in public_inputs.iter() {
            encoded_inputs.append(&Bytes::from_array(&env, &input.to_array()));
        }
        let public_inputs_hash: BytesN<32> = env.crypto().sha256(&encoded_inputs).into();

        let nonce_key = DataKey::NextNonce(owner.clone());
        let expected: u64 = env.storage().persistent().get(&nonce_key).unwrap_or(0);
        if nonce != expected {
            return Err(ControlPlaneV2Error::InvalidNonce);
        }
        let next = nonce
            .checked_add(1)
            .ok_or(ControlPlaneV2Error::NonceExhausted)?;
        let workflow_key = DataKey::Workflow(owner.clone(), nonce);
        let nullifier_key = DataKey::Nullifier(nullifier.clone());
        if env.storage().persistent().has(&workflow_key) {
            return Err(ControlPlaneV2Error::WorkflowAlreadyExists);
        }
        if env.storage().persistent().has(&nullifier_key) {
            return Err(ControlPlaneV2Error::NullifierAlreadyUsed);
        }

        let record = WorkflowRecordV2 {
            owner: owner.clone(),
            nonce,
            workflow_root: workflow_root.clone(),
            policy_root: policy_root.clone(),
            protocol_registry_root,
            asset_registry_root,
            recipient_policy_root,
            selected_protocol_leaf: selected_protocol_leaf.clone(),
            selected_asset_leaf: selected_asset_leaf.clone(),
            selected_recipient_leaf: selected_recipient_leaf.clone(),
            nullifier: nullifier.clone(),
            execution_context_commitment,
            verifier_version,
            public_inputs_hash: public_inputs_hash.clone(),
            lane,
            status: WorkflowStatus::Active,
            receipt_root: None,
            committed_at_ledger: current,
            execution_expires_at_ledger,
            receipt_close_by_ledger,
            retention_floor_ledger,
        };
        env.storage().persistent().set(&workflow_key, &record);
        env.storage().persistent().set(&nullifier_key, &true);
        env.storage().persistent().set(&nonce_key, &next);
        extend_all(&env, &owner, nonce, &nullifier, retention_floor_ledger)?;

        let registry = Self::verifier_registry(env.clone())?;
        let accepted = PolicyVerifierRegistryClient::new(&env, &registry).verify(
            &verifier_version,
            &public_inputs,
            &proof,
        );
        if !accepted {
            return Err(ControlPlaneV2Error::PolicyProofRejected);
        }

        WorkflowV2Committed {
            owner,
            nonce,
            workflow_root,
            policy_root,
            selected_protocol_leaf,
            selected_asset_leaf,
            selected_recipient_leaf,
            nullifier,
            verifier_version,
            public_inputs_hash,
            lane,
            execution_expires_at_ledger,
            receipt_close_by_ledger,
        }
        .publish(&env);
        Ok(record)
    }

    pub fn finalize(
        env: Env,
        owner: Address,
        nonce: u64,
        receipt_root: BytesN<32>,
    ) -> Result<WorkflowRecordV2, ControlPlaneV2Error> {
        owner.require_auth();
        require_hash(&receipt_root)?;
        let key = DataKey::Workflow(owner.clone(), nonce);
        let mut record: WorkflowRecordV2 = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(ControlPlaneV2Error::WorkflowNotFound)?;
        if record.status != WorkflowStatus::Active {
            return Err(ControlPlaneV2Error::WorkflowNotActive);
        }
        if env.ledger().sequence() >= record.receipt_close_by_ledger {
            return Err(ControlPlaneV2Error::ReceiptWindowClosed);
        }
        record.status = WorkflowStatus::Finalized;
        record.receipt_root = Some(receipt_root.clone());
        env.storage().persistent().set(&key, &record);
        extend_all(
            &env,
            &owner,
            nonce,
            &record.nullifier,
            record.retention_floor_ledger,
        )?;
        WorkflowV2Finalized {
            owner,
            nonce,
            receipt_root,
            finalized_at_ledger: env.ledger().sequence(),
        }
        .publish(&env);
        Ok(record)
    }

    pub fn cancel(
        env: Env,
        owner: Address,
        nonce: u64,
    ) -> Result<WorkflowRecordV2, ControlPlaneV2Error> {
        owner.require_auth();
        let key = DataKey::Workflow(owner.clone(), nonce);
        let mut record: WorkflowRecordV2 = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(ControlPlaneV2Error::WorkflowNotFound)?;
        if record.status != WorkflowStatus::Active {
            return Err(ControlPlaneV2Error::WorkflowNotActive);
        }
        record.status = WorkflowStatus::Cancelled;
        env.storage().persistent().set(&key, &record);
        extend_all(
            &env,
            &owner,
            nonce,
            &record.nullifier,
            record.retention_floor_ledger,
        )?;
        WorkflowV2Cancelled {
            owner,
            nonce,
            cancelled_at_ledger: env.ledger().sequence(),
        }
        .publish(&env);
        Ok(record)
    }
}

fn u32_scalar(env: &Env, value: u32) -> BytesN<32> {
    let mut bytes = [0_u8; 32];
    bytes[28..].copy_from_slice(&value.to_be_bytes());
    BytesN::from_array(env, &bytes)
}

fn require_hash(value: &BytesN<32>) -> Result<(), ControlPlaneV2Error> {
    if value.to_array() == [0_u8; 32] {
        return Err(ControlPlaneV2Error::InvalidHash);
    }
    Ok(())
}

fn validate_deadlines(
    env: &Env,
    current: u32,
    execution_expiry: u32,
    receipt_close: u32,
    retention: u32,
) -> Result<(), ControlPlaneV2Error> {
    if execution_expiry <= current {
        return Err(ControlPlaneV2Error::InvalidExpiry);
    }
    if receipt_close <= execution_expiry {
        return Err(ControlPlaneV2Error::InvalidReceiptDeadline);
    }
    if retention < receipt_close {
        return Err(ControlPlaneV2Error::InvalidRetention);
    }
    let ttl = retention
        .checked_sub(current)
        .ok_or(ControlPlaneV2Error::InvalidRetention)?;
    if ttl == 0 {
        return Err(ControlPlaneV2Error::InvalidRetention);
    }
    if ttl > env.storage().max_ttl() {
        return Err(ControlPlaneV2Error::BeyondMaximumTtl);
    }
    Ok(())
}

fn extend_all(
    env: &Env,
    owner: &Address,
    nonce: u64,
    nullifier: &BytesN<32>,
    retention: u32,
) -> Result<(), ControlPlaneV2Error> {
    let ttl = retention
        .checked_sub(env.ledger().sequence())
        .ok_or(ControlPlaneV2Error::InvalidRetention)?;
    if ttl == 0 || ttl > env.storage().max_ttl() {
        return Err(ControlPlaneV2Error::BeyondMaximumTtl);
    }
    env.storage()
        .persistent()
        .extend_ttl(&DataKey::Workflow(owner.clone(), nonce), ttl, ttl);
    env.storage()
        .persistent()
        .extend_ttl(&DataKey::Nullifier(nullifier.clone()), ttl, ttl);
    env.storage()
        .persistent()
        .extend_ttl(&DataKey::NextNonce(owner.clone()), ttl, ttl);
    env.storage().instance().extend_ttl(ttl, ttl);
    Ok(())
}

#[cfg(test)]
mod test;
