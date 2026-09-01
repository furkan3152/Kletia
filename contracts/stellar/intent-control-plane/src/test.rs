extern crate std;

use super::*;
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger as _},
    Address, Bytes, BytesN, Env, Vec,
};

#[contract]
struct ReviewedPolicyRegistry;

#[contractimpl]
impl ReviewedPolicyRegistry {
    pub fn verify(_env: Env, version: u32, public_inputs: Vec<BytesN<32>>, proof: Bytes) -> bool {
        version == 1 && public_inputs.len() == 9 && proof.get(0) == Some(1)
    }
}

fn hash(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

fn expected_public_inputs_hash(
    env: &Env,
    workflow_root: BytesN<32>,
    policy_root: BytesN<32>,
    nullifier: BytesN<32>,
) -> BytesN<32> {
    let inputs = [
        workflow_root,
        policy_root,
        hash(env, 4),
        hash(env, 5),
        hash(env, 6),
        u32_scalar(env, 1),
        u32_scalar(env, 200),
        nullifier,
        hash(env, 7),
    ];
    let mut encoded = Bytes::new(env);
    for input in inputs {
        encoded.append(&Bytes::from_array(env, &input.to_array()));
    }
    env.crypto().sha256(&encoded).into()
}

fn setup() -> (Env, KletiaIntentControlPlaneClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_sequence_number(100);
    let verifier_registry = env.register(ReviewedPolicyRegistry, ());
    let id = env.register(
        KletiaIntentControlPlane,
        KletiaIntentControlPlaneArgs::__constructor(&verifier_registry),
    );
    let client = KletiaIntentControlPlaneClient::new(&env, &id);
    let owner = Address::generate(&env);
    (env, client, owner)
}

#[allow(clippy::too_many_arguments)]
fn commit(
    env: &Env,
    client: &KletiaIntentControlPlaneClient<'_>,
    owner: &Address,
    nonce: u64,
    workflow_root: BytesN<32>,
    policy_root: BytesN<32>,
    nullifier: BytesN<32>,
    lane: EnvironmentLane,
    execution_expires_at_ledger: u32,
    receipt_close_by_ledger: u32,
    retention_floor_ledger: u32,
) -> WorkflowRecord {
    client.commit(
        owner,
        &nonce,
        &workflow_root,
        &policy_root,
        &hash(env, 4),
        &hash(env, 5),
        &hash(env, 6),
        &nullifier,
        &hash(env, 7),
        &lane,
        &execution_expires_at_ledger,
        &receipt_close_by_ledger,
        &retention_floor_ledger,
        &1,
        &Bytes::from_slice(env, &[1]),
    )
}

#[test]
fn commit_consumes_nonce_and_nullifier() {
    let (env, client, owner) = setup();
    let record = commit(
        &env,
        &client,
        &owner,
        0,
        hash(&env, 1),
        hash(&env, 2),
        hash(&env, 3),
        EnvironmentLane::Testnet,
        200,
        250,
        300,
    );
    assert_eq!(record.status, WorkflowStatus::Active);
    assert_eq!(client.next_nonce(&owner), 1);
    assert!(client.nullifier_used(&hash(&env, 3)));
    assert_eq!(record.verifier_version, 1);
    assert_eq!(
        record.public_inputs_hash,
        expected_public_inputs_hash(&env, hash(&env, 1), hash(&env, 2), hash(&env, 3)),
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #11)")]
fn nullifier_cannot_be_reused_by_another_owner() {
    let (env, client, owner) = setup();
    let nullifier = hash(&env, 3);
    commit(
        &env,
        &client,
        &owner,
        0,
        hash(&env, 1),
        hash(&env, 2),
        nullifier.clone(),
        EnvironmentLane::Testnet,
        200,
        250,
        300,
    );
    let second = Address::generate(&env);
    commit(
        &env,
        &client,
        &second,
        0,
        hash(&env, 8),
        hash(&env, 9),
        nullifier,
        EnvironmentLane::Testnet,
        200,
        250,
        300,
    );
}

#[test]
fn finalize_is_terminal_and_binds_receipt() {
    let (env, client, owner) = setup();
    commit(
        &env,
        &client,
        &owner,
        0,
        hash(&env, 1),
        hash(&env, 2),
        hash(&env, 3),
        EnvironmentLane::Testnet,
        200,
        250,
        300,
    );
    let record = client.finalize(&owner, &0, &hash(&env, 9));
    assert_eq!(record.status, WorkflowStatus::Finalized);
    assert_eq!(record.receipt_root, Some(hash(&env, 9)));
}

#[test]
fn cancellation_does_not_release_nullifier() {
    let (env, client, owner) = setup();
    let nullifier = hash(&env, 3);
    commit(
        &env,
        &client,
        &owner,
        0,
        hash(&env, 1),
        hash(&env, 2),
        nullifier.clone(),
        EnvironmentLane::Production,
        200,
        250,
        300,
    );
    let record = client.cancel(&owner, &0);
    assert_eq!(record.status, WorkflowStatus::Cancelled);
    assert!(client.nullifier_used(&nullifier));
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn nonce_must_be_exact() {
    let (env, client, owner) = setup();
    commit(
        &env,
        &client,
        &owner,
        1,
        hash(&env, 1),
        hash(&env, 2),
        hash(&env, 3),
        EnvironmentLane::Testnet,
        200,
        250,
        300,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn zero_hash_is_rejected() {
    let (env, client, owner) = setup();
    commit(
        &env,
        &client,
        &owner,
        0,
        BytesN::from_array(&env, &[0; 32]),
        hash(&env, 2),
        hash(&env, 3),
        EnvironmentLane::Testnet,
        200,
        250,
        300,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn receipt_window_must_follow_execution_expiry() {
    let (env, client, owner) = setup();
    commit(
        &env,
        &client,
        &owner,
        0,
        hash(&env, 1),
        hash(&env, 2),
        hash(&env, 3),
        EnvironmentLane::Testnet,
        200,
        200,
        300,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #16)")]
fn rejected_policy_proof_cannot_create_a_workflow() {
    let (env, client, owner) = setup();
    client.commit(
        &owner,
        &0,
        &hash(&env, 1),
        &hash(&env, 2),
        &hash(&env, 4),
        &hash(&env, 5),
        &hash(&env, 6),
        &hash(&env, 3),
        &hash(&env, 7),
        &EnvironmentLane::Testnet,
        &200,
        &250,
        &300,
        &1,
        &Bytes::from_slice(&env, &[0]),
    );
}
