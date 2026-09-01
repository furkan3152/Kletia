// SPDX-License-Identifier: MIT
#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype,
    crypto::bn254::{Bn254Fr, Bn254G1Affine, Bn254G2Affine},
    vec, Bytes, BytesN, Env, Vec,
};

const PROOF_LENGTH: u32 = 256;
const MAX_PUBLIC_INPUTS: u32 = 32;

#[contract]
pub struct KletiaPolicyGroth16Verifier;

#[contracttype]
#[derive(Clone)]
pub struct VerificationKey {
    pub alpha: BytesN<64>,
    pub beta: BytesN<128>,
    pub gamma: BytesN<128>,
    pub delta: BytesN<128>,
    pub ic: Vec<BytesN<64>>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifierMetadata {
    pub vk_hash: BytesN<32>,
    pub public_input_count: u32,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    VerificationKey,
    Metadata,
}

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Groth16VerifierError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    InvalidVerificationKey = 3,
    PublicInputCountMismatch = 4,
    NonCanonicalPublicInput = 5,
    InvalidProofLength = 6,
    InvalidProofPoint = 7,
    VerificationKeyHashMismatch = 8,
}

#[contractimpl]
impl KletiaPolicyGroth16Verifier {
    pub fn __constructor(
        env: Env,
        verification_key: VerificationKey,
    ) -> Result<(), Groth16VerifierError> {
        if env.storage().instance().has(&DataKey::Metadata) {
            return Err(Groth16VerifierError::AlreadyInitialized);
        }
        validate_verification_key(&env, &verification_key)?;
        let vk_hash = hash_verification_key(&env, &verification_key);
        let metadata = VerifierMetadata {
            vk_hash,
            public_input_count: verification_key.ic.len() - 1,
        };
        env.storage()
            .instance()
            .set(&DataKey::VerificationKey, &verification_key);
        env.storage().instance().set(&DataKey::Metadata, &metadata);
        Ok(())
    }

    pub fn metadata(env: Env) -> Result<VerifierMetadata, Groth16VerifierError> {
        env.storage()
            .instance()
            .get(&DataKey::Metadata)
            .ok_or(Groth16VerifierError::NotInitialized)
    }

    pub fn verify(
        env: Env,
        expected_vk_hash: BytesN<32>,
        public_inputs: Vec<BytesN<32>>,
        proof: Bytes,
    ) -> Result<bool, Groth16VerifierError> {
        let metadata = Self::metadata(env.clone())?;
        if expected_vk_hash != metadata.vk_hash {
            return Err(Groth16VerifierError::VerificationKeyHashMismatch);
        }
        if public_inputs.len() != metadata.public_input_count {
            return Err(Groth16VerifierError::PublicInputCountMismatch);
        }
        if proof.len() != PROOF_LENGTH {
            return Err(Groth16VerifierError::InvalidProofLength);
        }

        let verification_key: VerificationKey = env
            .storage()
            .instance()
            .get(&DataKey::VerificationKey)
            .ok_or(Groth16VerifierError::NotInitialized)?;
        let bn254 = env.crypto().bn254();

        let proof_a_bytes = bytes_n_from_slice::<64>(&env, &proof, 0);
        let proof_b_bytes = bytes_n_from_slice::<128>(&env, &proof, 64);
        let proof_c_bytes = bytes_n_from_slice::<64>(&env, &proof, 192);
        if is_zero(&proof_a_bytes) || is_zero(&proof_b_bytes) || is_zero(&proof_c_bytes) {
            return Err(Groth16VerifierError::InvalidProofPoint);
        }
        let proof_a = Bn254G1Affine::from_bytes(proof_a_bytes);
        let proof_b = Bn254G2Affine::from_bytes(proof_b_bytes);
        let proof_c = Bn254G1Affine::from_bytes(proof_c_bytes);
        if !bn254.g1_is_on_curve(&proof_a) || !bn254.g1_is_on_curve(&proof_c) {
            return Err(Groth16VerifierError::InvalidProofPoint);
        }

        let mut scalars = Vec::new(&env);
        for encoded in public_inputs.iter() {
            let scalar = Bn254Fr::from_bytes(encoded.clone());
            if scalar.to_bytes() != encoded {
                return Err(Groth16VerifierError::NonCanonicalPublicInput);
            }
            scalars.push_back(scalar);
        }
        let mut points = Vec::new(&env);
        for encoded in verification_key.ic.iter().skip(1) {
            points.push_back(Bn254G1Affine::from_bytes(encoded));
        }
        let ic_zero = Bn254G1Affine::from_bytes(verification_key.ic.get(0).unwrap());
        let vk_x = bn254.g1_add(&ic_zero, &bn254.g1_msm(points, scalars));

        let alpha = Bn254G1Affine::from_bytes(verification_key.alpha);
        let beta = Bn254G2Affine::from_bytes(verification_key.beta);
        let gamma = Bn254G2Affine::from_bytes(verification_key.gamma);
        let delta = Bn254G2Affine::from_bytes(verification_key.delta);
        Ok(bn254.pairing_check(
            vec![&env, -proof_a, alpha, vk_x, proof_c],
            vec![&env, proof_b, beta, gamma, delta],
        ))
    }
}

fn validate_verification_key(
    env: &Env,
    verification_key: &VerificationKey,
) -> Result<(), Groth16VerifierError> {
    if verification_key.ic.len() < 2 || verification_key.ic.len() > MAX_PUBLIC_INPUTS + 1 {
        return Err(Groth16VerifierError::InvalidVerificationKey);
    }
    if is_zero(&verification_key.alpha)
        || is_zero(&verification_key.beta)
        || is_zero(&verification_key.gamma)
        || is_zero(&verification_key.delta)
    {
        return Err(Groth16VerifierError::InvalidVerificationKey);
    }

    let bn254 = env.crypto().bn254();
    let alpha = Bn254G1Affine::from_bytes(verification_key.alpha.clone());
    if !bn254.g1_is_on_curve(&alpha) {
        return Err(Groth16VerifierError::InvalidVerificationKey);
    }
    for point in verification_key.ic.iter() {
        if !bn254.g1_is_on_curve(&Bn254G1Affine::from_bytes(point)) {
            return Err(Groth16VerifierError::InvalidVerificationKey);
        }
    }

    // e(alpha, q) * e(-alpha, q) == 1 for every valid G2 point q. This
    // constructor-only check asks the host to validate all three G2 encodings
    // and their subgroup membership before the immutable key is accepted.
    let neg_alpha = -alpha.clone();
    let beta = Bn254G2Affine::from_bytes(verification_key.beta.clone());
    let gamma = Bn254G2Affine::from_bytes(verification_key.gamma.clone());
    let delta = Bn254G2Affine::from_bytes(verification_key.delta.clone());
    if !bn254.pairing_check(
        vec![
            env,
            alpha.clone(),
            neg_alpha.clone(),
            alpha.clone(),
            neg_alpha.clone(),
            alpha,
            neg_alpha,
        ],
        vec![
            env,
            beta.clone(),
            beta,
            gamma.clone(),
            gamma,
            delta.clone(),
            delta,
        ],
    ) {
        return Err(Groth16VerifierError::InvalidVerificationKey);
    }
    Ok(())
}

fn hash_verification_key(env: &Env, verification_key: &VerificationKey) -> BytesN<32> {
    let mut encoded = Bytes::new(env);
    encoded.append(&Bytes::from_array(env, &verification_key.alpha.to_array()));
    encoded.append(&Bytes::from_array(env, &verification_key.beta.to_array()));
    encoded.append(&Bytes::from_array(env, &verification_key.gamma.to_array()));
    encoded.append(&Bytes::from_array(env, &verification_key.delta.to_array()));
    encoded.append(&Bytes::from_array(
        env,
        &verification_key.ic.len().to_be_bytes(),
    ));
    for point in verification_key.ic.iter() {
        encoded.append(&Bytes::from_array(env, &point.to_array()));
    }
    env.crypto().sha256(&encoded).into()
}

fn bytes_n_from_slice<const N: usize>(env: &Env, source: &Bytes, start: u32) -> BytesN<N> {
    let mut output = [0_u8; N];
    source
        .slice(start..start + N as u32)
        .copy_into_slice(&mut output);
    BytesN::from_array(env, &output)
}

fn is_zero<const N: usize>(value: &BytesN<N>) -> bool {
    value.to_array().iter().all(|byte| *byte == 0)
}

#[cfg(test)]
mod test;
