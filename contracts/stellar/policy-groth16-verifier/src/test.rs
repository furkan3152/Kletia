extern crate std;

use super::*;
use serde::Deserialize;
use soroban_sdk::{Bytes, BytesN, Env, Vec};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TestVector {
    warning: std::string::String,
    vk: JsonVerificationKey,
    vk_hash: std::string::String,
    proof: std::string::String,
    public_inputs: std::vec::Vec<std::string::String>,
}

#[derive(Deserialize)]
struct JsonVerificationKey {
    alpha: std::string::String,
    beta: std::string::String,
    gamma: std::string::String,
    delta: std::string::String,
    ic: std::vec::Vec<std::string::String>,
}

fn decode_bytes_n<const N: usize>(env: &Env, encoded: &str) -> BytesN<N> {
    let bytes = hex::decode(encoded).unwrap();
    let array: [u8; N] = bytes.try_into().unwrap();
    BytesN::from_array(env, &array)
}

fn load_vector(env: &Env) -> (TestVector, VerificationKey) {
    let vector: TestVector = serde_json::from_str(include_str!("test-vector.json")).unwrap();
    assert_eq!(
        vector.warning,
        "UNSAFE SINGLE-CONTRIBUTOR LOCAL TEST SETUP - NEVER DEPLOY"
    );
    let mut ic = Vec::new(env);
    for point in &vector.vk.ic {
        ic.push_back(decode_bytes_n::<64>(env, point));
    }
    let verification_key = VerificationKey {
        alpha: decode_bytes_n::<64>(env, &vector.vk.alpha),
        beta: decode_bytes_n::<128>(env, &vector.vk.beta),
        gamma: decode_bytes_n::<128>(env, &vector.vk.gamma),
        delta: decode_bytes_n::<128>(env, &vector.vk.delta),
        ic,
    };
    (vector, verification_key)
}

fn setup() -> (Env, KletiaPolicyGroth16VerifierClient<'static>, TestVector) {
    let env = Env::default();
    let (vector, verification_key) = load_vector(&env);
    let id = env.register(
        KletiaPolicyGroth16Verifier,
        KletiaPolicyGroth16VerifierArgs::__constructor(&verification_key),
    );
    let client = KletiaPolicyGroth16VerifierClient::new(&env, &id);
    (env, client, vector)
}

fn inputs(env: &Env, vector: &TestVector) -> Vec<BytesN<32>> {
    let mut values = Vec::new(env);
    for input in &vector.public_inputs {
        values.push_back(decode_bytes_n::<32>(env, input));
    }
    values
}

#[test]
fn exact_snarkjs_test_proof_is_accepted() {
    let (env, client, vector) = setup();
    let expected_hash = decode_bytes_n::<32>(&env, &vector.vk_hash);
    let proof = Bytes::from_slice(&env, &hex::decode(&vector.proof).unwrap());
    assert!(client.verify(&expected_hash, &inputs(&env, &vector), &proof));
    assert_eq!(client.metadata().vk_hash, expected_hash);
    assert_eq!(client.metadata().public_input_count, 9);
}

#[test]
fn changed_public_input_is_rejected_cryptographically() {
    let (env, client, vector) = setup();
    let expected_hash = decode_bytes_n::<32>(&env, &vector.vk_hash);
    let proof = Bytes::from_slice(&env, &hex::decode(&vector.proof).unwrap());
    let mut changed = inputs(&env, &vector);
    let changed_workflow_root = "00".repeat(31) + "02";
    changed.set(0, decode_bytes_n::<32>(&env, &changed_workflow_root));
    assert!(!client.verify(&expected_hash, &changed, &proof));
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn non_canonical_scalar_is_rejected_before_pairing() {
    let (env, client, vector) = setup();
    let expected_hash = decode_bytes_n::<32>(&env, &vector.vk_hash);
    let proof = Bytes::from_slice(&env, &hex::decode(&vector.proof).unwrap());
    let mut changed = inputs(&env, &vector);
    changed.set(
        0,
        decode_bytes_n::<32>(
            &env,
            "30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001",
        ),
    );
    client.verify(&expected_hash, &changed, &proof);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn exact_public_input_count_is_required() {
    let (env, client, vector) = setup();
    let expected_hash = decode_bytes_n::<32>(&env, &vector.vk_hash);
    let proof = Bytes::from_slice(&env, &hex::decode(&vector.proof).unwrap());
    let mut shortened = inputs(&env, &vector);
    shortened.pop_back();
    client.verify(&expected_hash, &shortened, &proof);
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")]
fn proof_length_is_exact() {
    let (env, client, vector) = setup();
    let expected_hash = decode_bytes_n::<32>(&env, &vector.vk_hash);
    client.verify(
        &expected_hash,
        &inputs(&env, &vector),
        &Bytes::from_array(&env, &[1_u8; 32]),
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #8)")]
fn registry_vk_hash_must_match_constructor_key() {
    let (env, client, vector) = setup();
    let proof = Bytes::from_slice(&env, &hex::decode(&vector.proof).unwrap());
    client.verify(
        &BytesN::from_array(&env, &[7_u8; 32]),
        &inputs(&env, &vector),
        &proof,
    );
}
