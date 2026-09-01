extern crate std;

use super::*;
use kletia_policy_groth16_verifier::{
    KletiaPolicyGroth16Verifier, KletiaPolicyGroth16VerifierArgs,
    KletiaPolicyGroth16VerifierClient, VerificationKey,
};
use serde::Deserialize;
use soroban_sdk::{
    contract, contractimpl, testutils::Address as _, Address, Bytes, BytesN, Env, Vec,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Groth16TestVector {
    vk: JsonVerificationKey,
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

#[contract]
struct TestVerifier;

#[contractimpl]
impl TestVerifier {
    pub fn verify(
        _env: Env,
        vk_hash: BytesN<32>,
        public_inputs: Vec<BytesN<32>>,
        proof: Bytes,
    ) -> bool {
        vk_hash.to_array() == [1; 32] && public_inputs.len() == 9 && proof.len() == 4
    }
}

fn hash(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

fn decode_bytes_n<const N: usize>(env: &Env, encoded: &str) -> BytesN<N> {
    let bytes = hex::decode(encoded).unwrap();
    let array: [u8; N] = bytes.try_into().unwrap();
    BytesN::from_array(env, &array)
}

fn groth16_fixture(env: &Env) -> (Groth16TestVector, VerificationKey) {
    let fixture: Groth16TestVector = serde_json::from_str(include_str!(
        "../../policy-groth16-verifier/src/test-vector.json"
    ))
    .unwrap();
    let mut ic = Vec::new(env);
    for point in &fixture.vk.ic {
        ic.push_back(decode_bytes_n::<64>(env, point));
    }
    let key = VerificationKey {
        alpha: decode_bytes_n::<64>(env, &fixture.vk.alpha),
        beta: decode_bytes_n::<128>(env, &fixture.vk.beta),
        gamma: decode_bytes_n::<128>(env, &fixture.vk.gamma),
        delta: decode_bytes_n::<128>(env, &fixture.vk.delta),
        ic,
    };
    (fixture, key)
}

fn u32_input(env: &Env, value: u32) -> BytesN<32> {
    let mut bytes = [0_u8; 32];
    bytes[28..].copy_from_slice(&value.to_be_bytes());
    BytesN::from_array(env, &bytes)
}

fn policy_inputs(env: &Env, lane: u32, expiry: u32) -> Vec<BytesN<32>> {
    Vec::from_array(
        env,
        [
            hash(env, 4),
            hash(env, 5),
            hash(env, 6),
            hash(env, 7),
            hash(env, 8),
            u32_input(env, lane),
            u32_input(env, expiry),
            hash(env, 9),
            hash(env, 10),
        ],
    )
}

fn setup() -> (
    Env,
    KletiaPolicyVerifierRegistryClient<'static>,
    Address,
    Address,
) {
    let env = Env::default();
    env.mock_all_auths();
    let registry_id = env.register(KletiaPolicyVerifierRegistry, ());
    let verifier_id = env.register(TestVerifier, ());
    let registry = KletiaPolicyVerifierRegistryClient::new(&env, &registry_id);
    let admin = Address::generate(&env);
    registry.initialize(&admin);
    (env, registry, admin, verifier_id)
}

#[test]
fn version_is_registered_once_and_dispatched() {
    let (env, registry, _admin, verifier) = setup();
    registry.register(
        &1,
        &verifier,
        &hash(&env, 1),
        &hash(&env, 2),
        &hash(&env, 3),
        &9,
        &5,
        &6,
        &1_000,
    );
    let inputs = policy_inputs(&env, 1, 100);
    let proof = Bytes::from_array(&env, &[1, 2, 3, 4]);
    assert!(registry.verify(&1, &inputs, &proof));
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn version_cannot_be_overwritten() {
    let (env, registry, _admin, verifier) = setup();
    registry.register(
        &1,
        &verifier,
        &hash(&env, 1),
        &hash(&env, 2),
        &hash(&env, 3),
        &9,
        &5,
        &6,
        &1_000,
    );
    registry.register(
        &1,
        &verifier,
        &hash(&env, 1),
        &hash(&env, 2),
        &hash(&env, 3),
        &9,
        &5,
        &6,
        &1_000,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #7)")]
fn disabled_version_fails_closed() {
    let (env, registry, _admin, verifier) = setup();
    registry.register(
        &1,
        &verifier,
        &hash(&env, 1),
        &hash(&env, 2),
        &hash(&env, 3),
        &9,
        &5,
        &6,
        &1_000,
    );
    registry.set_enabled(&1, &false);
    let inputs = policy_inputs(&env, 1, 100);
    let proof = Bytes::from_array(&env, &[1, 2, 3, 4]);
    registry.verify(&1, &inputs, &proof);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn zero_artifact_hash_is_rejected() {
    let (env, registry, _admin, verifier) = setup();
    registry.register(
        &1,
        &verifier,
        &BytesN::from_array(&env, &[0; 32]),
        &hash(&env, 2),
        &hash(&env, 3),
        &9,
        &5,
        &6,
        &1_000,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #12)")]
fn lane_must_be_production_or_testnet() {
    let (env, registry, _admin, verifier) = setup();
    registry.register(
        &1,
        &verifier,
        &hash(&env, 1),
        &hash(&env, 2),
        &hash(&env, 3),
        &9,
        &5,
        &6,
        &1_000,
    );
    registry.verify(
        &1,
        &policy_inputs(&env, 2, 100),
        &Bytes::from_array(&env, &[1, 2, 3, 4]),
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #13)")]
fn expiry_is_checked_against_the_invocation_ledger() {
    let (env, registry, _admin, verifier) = setup();
    registry.register(
        &1,
        &verifier,
        &hash(&env, 1),
        &hash(&env, 2),
        &hash(&env, 3),
        &9,
        &5,
        &6,
        &1_000,
    );
    registry.verify(
        &1,
        &policy_inputs(&env, 1, 0),
        &Bytes::from_array(&env, &[1, 2, 3, 4]),
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #10)")]
fn public_input_count_is_pinned() {
    let (env, registry, _admin, verifier) = setup();
    registry.register(
        &1,
        &verifier,
        &hash(&env, 1),
        &hash(&env, 2),
        &hash(&env, 3),
        &9,
        &5,
        &6,
        &1_000,
    );
    registry.verify(
        &1,
        &Vec::from_array(&env, [hash(&env, 4)]),
        &Bytes::from_array(&env, &[1, 2, 3, 4]),
    );
}

#[test]
fn registry_dispatches_the_real_bn254_verifier_interface() {
    let (env, registry, _admin, _mock_verifier) = setup();
    let (fixture, key) = groth16_fixture(&env);
    let verifier_id = env.register(
        KletiaPolicyGroth16Verifier,
        KletiaPolicyGroth16VerifierArgs::__constructor(&key),
    );
    let verifier = KletiaPolicyGroth16VerifierClient::new(&env, &verifier_id);
    let metadata = verifier.metadata();
    registry.register(
        &1,
        &verifier_id,
        &metadata.vk_hash,
        &hash(&env, 2),
        &hash(&env, 3),
        &9,
        &5,
        &6,
        &1_000,
    );
    let mut public_inputs = Vec::new(&env);
    for input in &fixture.public_inputs {
        public_inputs.push_back(decode_bytes_n::<32>(&env, input));
    }
    let proof = Bytes::from_slice(&env, &hex::decode(fixture.proof).unwrap());
    assert!(registry.verify(&1, &public_inputs, &proof));
}
