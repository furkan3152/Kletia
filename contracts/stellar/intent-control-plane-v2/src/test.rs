extern crate std;

use super::*;
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger as _},
    Address, Bytes, BytesN, Env, Vec,
};

#[contract]
struct ReviewedPolicyV2Registry;

#[contractimpl]
impl ReviewedPolicyV2Registry {
    pub fn verify(_env: Env, version: u32, public_inputs: Vec<BytesN<32>>, proof: Bytes) -> bool {
        version == 2 && public_inputs.len() == 12 && proof.get(0) == Some(2)
    }
}

fn hash(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

fn setup() -> (Env, KletiaIntentControlPlaneV2Client<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_sequence_number(100);
    let registry = env.register(ReviewedPolicyV2Registry, ());
    let id = env.register(
        KletiaIntentControlPlaneV2,
        KletiaIntentControlPlaneV2Args::__constructor(&registry),
    );
    let owner = Address::generate(&env);
    let client = KletiaIntentControlPlaneV2Client::new(&env, &id);
    (env, client, owner)
}

#[allow(clippy::too_many_arguments)]
fn commit(
    env: &Env,
    client: &KletiaIntentControlPlaneV2Client<'_>,
    owner: &Address,
    nonce: u64,
    nullifier: BytesN<32>,
    proof_byte: u8,
) -> WorkflowRecordV2 {
    client.commit(
        owner,
        &nonce,
        &hash(env, 1),
        &hash(env, 2),
        &hash(env, 3),
        &hash(env, 4),
        &hash(env, 5),
        &hash(env, 6),
        &hash(env, 7),
        &hash(env, 8),
        &nullifier,
        &hash(env, 9),
        &EnvironmentLane::Testnet,
        &200,
        &250,
        &300,
        &2,
        &Bytes::from_slice(env, &[proof_byte]),
    )
}

#[test]
fn commit_pins_policy_v2_selected_leaves_and_nullifier() {
    let (env, client, owner) = setup();
    let record = commit(&env, &client, &owner, 0, hash(&env, 10), 2);
    assert_eq!(record.status, WorkflowStatus::Active);
    assert_eq!(record.verifier_version, 2);
    assert_eq!(record.selected_protocol_leaf, hash(&env, 6));
    assert_eq!(record.selected_asset_leaf, hash(&env, 7));
    assert_eq!(record.selected_recipient_leaf, hash(&env, 8));
    assert!(client.nullifier_used(&hash(&env, 10)));
    assert_eq!(client.next_nonce(&owner), 1);
}

#[test]
fn finalize_binds_one_terminal_receipt_root() {
    let (env, client, owner) = setup();
    commit(&env, &client, &owner, 0, hash(&env, 10), 2);
    let finalized = client.finalize(&owner, &0, &hash(&env, 11));
    assert_eq!(finalized.status, WorkflowStatus::Finalized);
    assert_eq!(finalized.receipt_root, Some(hash(&env, 11)));
}

#[test]
#[should_panic(expected = "Error(Contract, #11)")]
fn global_nullifier_reuse_is_rejected() {
    let (env, client, owner) = setup();
    let nullifier = hash(&env, 10);
    commit(&env, &client, &owner, 0, nullifier.clone(), 2);
    let second = Address::generate(&env);
    commit(&env, &client, &second, 0, nullifier, 2);
}

#[test]
#[should_panic(expected = "Error(Contract, #16)")]
fn rejected_proof_rolls_back_reserved_state() {
    let (env, client, owner) = setup();
    commit(&env, &client, &owner, 0, hash(&env, 10), 0);
}

#[test]
fn failed_verification_does_not_consume_nonce_or_nullifier() {
    let (env, client, owner) = setup();
    let nullifier = hash(&env, 10);
    let result = client.try_commit(
        &owner,
        &0,
        &hash(&env, 1),
        &hash(&env, 2),
        &hash(&env, 3),
        &hash(&env, 4),
        &hash(&env, 5),
        &hash(&env, 6),
        &hash(&env, 7),
        &hash(&env, 8),
        &nullifier,
        &hash(&env, 9),
        &EnvironmentLane::Testnet,
        &200,
        &250,
        &300,
        &2,
        &Bytes::from_slice(&env, &[0]),
    );
    assert!(result.is_err());
    assert_eq!(client.next_nonce(&owner), 0);
    assert!(!client.nullifier_used(&nullifier));
}
