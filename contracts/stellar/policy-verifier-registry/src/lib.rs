// SPDX-License-Identifier: MIT
#![no_std]

use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype, Address,
    Bytes, BytesN, Env, Vec,
};

#[contractclient(name = "PolicyProofVerifierClient")]
pub trait PolicyProofVerifier {
    fn verify(env: Env, vk_hash: BytesN<32>, public_inputs: Vec<BytesN<32>>, proof: Bytes) -> bool;
}

#[contract]
pub struct KletiaPolicyVerifierRegistry;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifierRecord {
    pub version: u32,
    pub verifier: Address,
    pub vk_hash: BytesN<32>,
    pub circuit_hash: BytesN<32>,
    pub public_input_schema_hash: BytesN<32>,
    pub public_input_count: u32,
    pub lane_input_index: u32,
    pub expiry_ledger_input_index: u32,
    pub enabled: bool,
    pub registered_at_ledger: u32,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    Verifier(u32),
}

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum VerifierRegistryError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    InvalidVersion = 3,
    InvalidHash = 4,
    VersionAlreadyExists = 5,
    VersionNotFound = 6,
    VersionDisabled = 7,
    InvalidPublicInputs = 8,
    InvalidProof = 9,
    PublicInputCountMismatch = 10,
    PublicInputEncodingInvalid = 11,
    InvalidLane = 12,
    PolicyExpired = 13,
    InvalidInputIndex = 14,
}

#[contractevent(topics = ["verifier_registered"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifierRegistered {
    #[topic]
    pub version: u32,
    pub verifier: Address,
    pub vk_hash: BytesN<32>,
    pub circuit_hash: BytesN<32>,
    pub public_input_schema_hash: BytesN<32>,
}

#[contractevent(topics = ["verifier_status"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifierStatusChanged {
    #[topic]
    pub version: u32,
    pub enabled: bool,
}

#[contractevent(topics = ["policy_proof"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PolicyProofChecked {
    #[topic]
    pub version: u32,
    pub public_inputs_hash: BytesN<32>,
    pub accepted: bool,
}

#[contractimpl]
impl KletiaPolicyVerifierRegistry {
    pub fn initialize(env: Env, admin: Address) -> Result<(), VerifierRegistryError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(VerifierRegistryError::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        Ok(())
    }

    pub fn admin(env: Env) -> Result<Address, VerifierRegistryError> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(VerifierRegistryError::NotInitialized)
    }

    pub fn get(env: Env, version: u32) -> Option<VerifierRecord> {
        env.storage().persistent().get(&DataKey::Verifier(version))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn register(
        env: Env,
        version: u32,
        verifier: Address,
        vk_hash: BytesN<32>,
        circuit_hash: BytesN<32>,
        public_input_schema_hash: BytesN<32>,
        public_input_count: u32,
        lane_input_index: u32,
        expiry_ledger_input_index: u32,
        retention_ledgers: u32,
    ) -> Result<VerifierRecord, VerifierRegistryError> {
        let admin = Self::admin(env.clone())?;
        admin.require_auth();
        if version == 0 {
            return Err(VerifierRegistryError::InvalidVersion);
        }
        require_hash(&vk_hash)?;
        require_hash(&circuit_hash)?;
        require_hash(&public_input_schema_hash)?;
        if public_input_count == 0 || public_input_count > 32 {
            return Err(VerifierRegistryError::InvalidPublicInputs);
        }
        if lane_input_index >= public_input_count || expiry_ledger_input_index >= public_input_count
        {
            return Err(VerifierRegistryError::InvalidInputIndex);
        }
        let key = DataKey::Verifier(version);
        if env.storage().persistent().has(&key) {
            return Err(VerifierRegistryError::VersionAlreadyExists);
        }
        if retention_ledgers == 0 || retention_ledgers > env.storage().max_ttl() {
            return Err(VerifierRegistryError::InvalidVersion);
        }
        let record = VerifierRecord {
            version,
            verifier: verifier.clone(),
            vk_hash: vk_hash.clone(),
            circuit_hash: circuit_hash.clone(),
            public_input_schema_hash: public_input_schema_hash.clone(),
            public_input_count,
            lane_input_index,
            expiry_ledger_input_index,
            enabled: true,
            registered_at_ledger: env.ledger().sequence(),
        };
        env.storage().persistent().set(&key, &record);
        env.storage()
            .persistent()
            .extend_ttl(&key, retention_ledgers, retention_ledgers);
        VerifierRegistered {
            version,
            verifier,
            vk_hash,
            circuit_hash,
            public_input_schema_hash,
        }
        .publish(&env);
        Ok(record)
    }

    pub fn set_enabled(
        env: Env,
        version: u32,
        enabled: bool,
    ) -> Result<VerifierRecord, VerifierRegistryError> {
        let admin = Self::admin(env.clone())?;
        admin.require_auth();
        let key = DataKey::Verifier(version);
        let mut record: VerifierRecord = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(VerifierRegistryError::VersionNotFound)?;
        record.enabled = enabled;
        env.storage().persistent().set(&key, &record);
        VerifierStatusChanged { version, enabled }.publish(&env);
        Ok(record)
    }

    pub fn verify(
        env: Env,
        version: u32,
        public_inputs: Vec<BytesN<32>>,
        proof: Bytes,
    ) -> Result<bool, VerifierRegistryError> {
        let record =
            Self::get(env.clone(), version).ok_or(VerifierRegistryError::VersionNotFound)?;
        if !record.enabled {
            return Err(VerifierRegistryError::VersionDisabled);
        }
        if public_inputs.len() != record.public_input_count {
            return Err(VerifierRegistryError::PublicInputCountMismatch);
        }
        if proof.is_empty() || proof.len() > 16_384 {
            return Err(VerifierRegistryError::InvalidProof);
        }
        let lane = decode_u32(&public_inputs.get(record.lane_input_index).unwrap())?;
        if lane > 1 {
            return Err(VerifierRegistryError::InvalidLane);
        }
        let expiry = decode_u32(&public_inputs.get(record.expiry_ledger_input_index).unwrap())?;
        if expiry <= env.ledger().sequence() {
            return Err(VerifierRegistryError::PolicyExpired);
        }
        let mut encoded = Bytes::new(&env);
        for input in public_inputs.iter() {
            encoded.append(&Bytes::from_array(&env, &input.to_array()));
        }
        let public_inputs_hash: BytesN<32> = env.crypto().sha256(&encoded).into();
        let accepted = PolicyProofVerifierClient::new(&env, &record.verifier).verify(
            &record.vk_hash,
            &public_inputs,
            &proof,
        );
        PolicyProofChecked {
            version,
            public_inputs_hash,
            accepted,
        }
        .publish(&env);
        Ok(accepted)
    }
}

fn decode_u32(value: &BytesN<32>) -> Result<u32, VerifierRegistryError> {
    let bytes = value.to_array();
    if bytes[..28].iter().any(|byte| *byte != 0) {
        return Err(VerifierRegistryError::PublicInputEncodingInvalid);
    }
    Ok(u32::from_be_bytes([
        bytes[28], bytes[29], bytes[30], bytes[31],
    ]))
}

fn require_hash(value: &BytesN<32>) -> Result<(), VerifierRegistryError> {
    if value.to_array() == [0_u8; 32] {
        return Err(VerifierRegistryError::InvalidHash);
    }
    Ok(())
}

#[cfg(test)]
mod test;
