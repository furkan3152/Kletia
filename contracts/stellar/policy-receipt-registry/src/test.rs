// SPDX-License-Identifier: MIT

extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{storage::Persistent as _, Address as _, Events as _, Ledger as _},
    Address, BytesN, Env,
};

const START_LEDGER: u32 = 1_000;
const MAX_ENTRY_TTL: u32 = 10_000;
const EXECUTION_EXPIRES: u32 = START_LEDGER + 100;
const RECEIPT_CLOSES: u32 = START_LEDGER + 300;
const RETENTION_FLOOR: u32 = START_LEDGER + 1_000;

fn setup() -> (Env, Address, Address) {
    let env = Env::default();
    env.ledger().set_sequence_number(START_LEDGER);
    env.ledger().set_max_entry_ttl(MAX_ENTRY_TTL);
    env.mock_all_auths();

    let contract_id = env.register(KletiaPolicyReceiptRegistry, ());
    let owner = Address::generate(&env);
    (env, contract_id, owner)
}

fn hash(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

fn commit_default(env: &Env, contract_id: &Address, owner: &Address, nonce: u64) -> PolicyRecord {
    let client = KletiaPolicyReceiptRegistryClient::new(env, contract_id);
    client.commit(
        owner,
        &nonce,
        &hash(env, 1),
        &hash(env, 2),
        &EXECUTION_EXPIRES,
        &RECEIPT_CLOSES,
        &RETENTION_FLOOR,
    )
}

#[test]
fn commit_records_hashes_consumes_nonce_and_requires_owner_auth() {
    let (env, contract_id, owner) = setup();
    let client = KletiaPolicyReceiptRegistryClient::new(&env, &contract_id);

    let record = commit_default(&env, &contract_id, &owner, 0);
    let auths = env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, owner);
    assert_eq!(env.events().all().events().len(), 1);

    assert_eq!(record.owner, owner);
    assert_eq!(record.nonce, 0);
    assert_eq!(record.manifest_hash, hash(&env, 1));
    assert_eq!(record.privacy_budget_hash, hash(&env, 2));
    assert_eq!(record.receipt_hash, None);
    assert_eq!(record.status, RecordStatus::Active);
    assert_eq!(record.committed_at_ledger, START_LEDGER);
    assert_eq!(record.execution_expires_at_ledger, EXECUTION_EXPIRES);
    assert_eq!(record.receipt_close_by_ledger, RECEIPT_CLOSES);
    assert_eq!(record.retention_floor_ledger, RETENTION_FLOOR);
    assert_eq!(client.next_nonce(&owner), 1);
    assert_eq!(client.get(&owner, &0), Some(record));
    assert!(client.is_active(&owner, &0));
    assert!(client.can_finalize(&owner, &0));
    assert_eq!(
        client.effective_status(&owner, &0),
        Some(EffectiveStatus::Active)
    );
}

#[test]
fn replay_and_out_of_order_nonces_are_rejected() {
    let (env, contract_id, owner) = setup();
    let client = KletiaPolicyReceiptRegistryClient::new(&env, &contract_id);
    commit_default(&env, &contract_id, &owner, 0);

    assert_eq!(
        client.try_commit(
            &owner,
            &0,
            &hash(&env, 3),
            &hash(&env, 4),
            &EXECUTION_EXPIRES,
            &RECEIPT_CLOSES,
            &RETENTION_FLOOR,
        ),
        Err(Ok(RegistryError::InvalidNonce))
    );
    assert_eq!(
        client.try_commit(
            &owner,
            &2,
            &hash(&env, 3),
            &hash(&env, 4),
            &EXECUTION_EXPIRES,
            &RECEIPT_CLOSES,
            &RETENTION_FLOOR,
        ),
        Err(Ok(RegistryError::InvalidNonce))
    );

    commit_default(&env, &contract_id, &owner, 1);
    assert_eq!(client.next_nonce(&owner), 2);
}

#[test]
fn expiry_and_retention_are_bounded_by_the_ledger_configuration() {
    let (env, contract_id, owner) = setup();
    let client = KletiaPolicyReceiptRegistryClient::new(&env, &contract_id);

    assert_eq!(
        client.try_commit(
            &owner,
            &0,
            &hash(&env, 1),
            &hash(&env, 2),
            &START_LEDGER,
            &RECEIPT_CLOSES,
            &(START_LEDGER + 100),
        ),
        Err(Ok(RegistryError::InvalidExpiry))
    );
    assert_eq!(
        client.try_commit(
            &owner,
            &0,
            &hash(&env, 1),
            &hash(&env, 2),
            &(START_LEDGER + 200),
            &(START_LEDGER + 200),
            &RETENTION_FLOOR,
        ),
        Err(Ok(RegistryError::InvalidReceiptDeadline))
    );
    assert_eq!(
        client.try_commit(
            &owner,
            &0,
            &hash(&env, 1),
            &hash(&env, 2),
            &EXECUTION_EXPIRES,
            &RECEIPT_CLOSES,
            &(START_LEDGER + 100),
        ),
        Err(Ok(RegistryError::InvalidRetention))
    );
    assert_eq!(
        client.try_commit(
            &owner,
            &0,
            &hash(&env, 1),
            &hash(&env, 2),
            &EXECUTION_EXPIRES,
            &(START_LEDGER + MAX_ENTRY_TTL + 1),
            &(START_LEDGER + MAX_ENTRY_TTL + 1),
        ),
        Err(Ok(RegistryError::BeyondMaximumTtl))
    );
}

#[test]
fn zero_hashes_are_rejected_before_state_changes() {
    let (env, contract_id, owner) = setup();
    let client = KletiaPolicyReceiptRegistryClient::new(&env, &contract_id);
    let zero = hash(&env, 0);

    assert_eq!(
        client.try_commit(
            &owner,
            &0,
            &zero,
            &hash(&env, 2),
            &EXECUTION_EXPIRES,
            &RECEIPT_CLOSES,
            &RETENTION_FLOOR,
        ),
        Err(Ok(RegistryError::InvalidHash))
    );
    assert_eq!(
        client.try_commit(
            &owner,
            &0,
            &hash(&env, 1),
            &zero,
            &EXECUTION_EXPIRES,
            &RECEIPT_CLOSES,
            &RETENTION_FLOOR,
        ),
        Err(Ok(RegistryError::InvalidHash))
    );
    assert_eq!(client.next_nonce(&owner), 0);
    assert_eq!(client.get(&owner, &0), None);

    commit_default(&env, &contract_id, &owner, 0);
    assert_eq!(
        client.try_finalize(&owner, &0, &zero),
        Err(Ok(RegistryError::InvalidHash))
    );
    assert!(client.is_active(&owner, &0));
}

#[test]
fn finalize_is_single_use_and_does_not_mutate_committed_hashes() {
    let (env, contract_id, owner) = setup();
    let client = KletiaPolicyReceiptRegistryClient::new(&env, &contract_id);
    let committed = commit_default(&env, &contract_id, &owner, 0);

    env.ledger().set_sequence_number(START_LEDGER + 10);
    let finalized = client.finalize(&owner, &0, &hash(&env, 9));
    assert_eq!(finalized.status, RecordStatus::Finalized);
    assert_eq!(finalized.receipt_hash, Some(hash(&env, 9)));
    assert_eq!(finalized.manifest_hash, committed.manifest_hash);
    assert_eq!(finalized.privacy_budget_hash, committed.privacy_budget_hash);
    assert!(!client.is_active(&owner, &0));
    assert!(!client.can_finalize(&owner, &0));
    assert_eq!(
        client.effective_status(&owner, &0),
        Some(EffectiveStatus::Finalized)
    );

    assert_eq!(
        client.try_finalize(&owner, &0, &hash(&env, 10)),
        Err(Ok(RegistryError::RecordNotActive))
    );
    assert_eq!(
        client.try_cancel(&owner, &0),
        Err(Ok(RegistryError::RecordNotActive))
    );
}

#[test]
fn cancellation_is_terminal_and_never_reuses_the_nonce() {
    let (env, contract_id, owner) = setup();
    let client = KletiaPolicyReceiptRegistryClient::new(&env, &contract_id);
    commit_default(&env, &contract_id, &owner, 0);

    let cancelled = client.cancel(&owner, &0);
    assert_eq!(cancelled.status, RecordStatus::Cancelled);
    assert_eq!(cancelled.receipt_hash, None);
    assert_eq!(client.next_nonce(&owner), 1);
    assert!(!client.is_active(&owner, &0));
    assert!(!client.can_finalize(&owner, &0));
    assert_eq!(
        client.effective_status(&owner, &0),
        Some(EffectiveStatus::Cancelled)
    );

    assert_eq!(
        client.try_finalize(&owner, &0, &hash(&env, 9)),
        Err(Ok(RegistryError::RecordNotActive))
    );
}

#[test]
fn execution_expiry_closes_execution_but_keeps_owner_receipt_finalization_open() {
    let (env, contract_id, owner) = setup();
    let client = KletiaPolicyReceiptRegistryClient::new(&env, &contract_id);
    commit_default(&env, &contract_id, &owner, 0);

    env.ledger().set_sequence_number(EXECUTION_EXPIRES);
    assert!(!client.is_active(&owner, &0));
    assert!(client.can_finalize(&owner, &0));
    assert_eq!(
        client.effective_status(&owner, &0),
        Some(EffectiveStatus::ExecutionExpiredAwaitingReceipt)
    );
    assert_eq!(
        client.try_cancel(&owner, &0),
        Err(Ok(RegistryError::PolicyExpired))
    );

    let finalized = client.finalize(&owner, &0, &hash(&env, 9));
    assert_eq!(finalized.status, RecordStatus::Finalized);
    assert!(!client.is_active(&owner, &0));
    assert!(!client.can_finalize(&owner, &0));
    assert_eq!(
        client.effective_status(&owner, &0),
        Some(EffectiveStatus::Finalized)
    );
}

#[test]
fn receipt_close_boundary_is_exclusive_and_does_not_reactivate_execution() {
    let (env, contract_id, owner) = setup();
    let client = KletiaPolicyReceiptRegistryClient::new(&env, &contract_id);
    commit_default(&env, &contract_id, &owner, 0);

    env.ledger().set_sequence_number(RECEIPT_CLOSES - 1);
    assert!(!client.is_active(&owner, &0));
    assert!(client.can_finalize(&owner, &0));

    env.ledger().set_sequence_number(RECEIPT_CLOSES);
    assert!(!client.is_active(&owner, &0));
    assert!(!client.can_finalize(&owner, &0));
    assert_eq!(
        client.effective_status(&owner, &0),
        Some(EffectiveStatus::ReceiptWindowClosed)
    );
    assert_eq!(
        client.try_finalize(&owner, &0, &hash(&env, 9)),
        Err(Ok(RegistryError::ReceiptWindowClosed))
    );
    assert_eq!(
        client.try_cancel(&owner, &0),
        Err(Ok(RegistryError::PolicyExpired))
    );
}

#[test]
fn ttl_extension_preserves_lifecycle_deadlines_and_increases_storage_ttl() {
    let (env, contract_id, owner) = setup();
    let client = KletiaPolicyReceiptRegistryClient::new(&env, &contract_id);
    let original = commit_default(&env, &contract_id, &owner, 0);
    let record_key = DataKey::Record(owner.clone(), 0);

    // Newly written entries may already start at the test ledger's maximum
    // TTL. Advance the ledger, then request the new maximum horizon so the
    // extension produces an observable increase.
    env.ledger().set_sequence_number(START_LEDGER + 10);
    let original_ttl = env.as_contract(&contract_id, || {
        env.storage().persistent().get_ttl(&record_key)
    });
    let max_ttl = env.as_contract(&contract_id, || env.storage().max_ttl());
    let new_retention = START_LEDGER + 10 + max_ttl;

    let extended = client.extend_ttl(&owner, &0, &new_retention);
    let extended_ttl = env.as_contract(&contract_id, || {
        env.storage().persistent().get_ttl(&record_key)
    });
    assert!(extended_ttl > original_ttl);
    assert_eq!(
        extended.execution_expires_at_ledger,
        original.execution_expires_at_ledger
    );
    assert_eq!(
        extended.receipt_close_by_ledger,
        original.receipt_close_by_ledger
    );
    assert_eq!(extended.status, original.status);
    assert_eq!(extended.retention_floor_ledger, new_retention);

    assert_eq!(
        client.try_extend_ttl(&owner, &0, &new_retention),
        Err(Ok(RegistryError::InvalidRetention))
    );
}

#[test]
fn owner_namespaces_are_isolated() {
    let (env, contract_id, owner_a) = setup();
    let owner_b = Address::generate(&env);
    let client = KletiaPolicyReceiptRegistryClient::new(&env, &contract_id);

    commit_default(&env, &contract_id, &owner_a, 0);
    let record_b = client.commit(
        &owner_b,
        &0,
        &hash(&env, 7),
        &hash(&env, 8),
        &EXECUTION_EXPIRES,
        &RECEIPT_CLOSES,
        &RETENTION_FLOOR,
    );

    assert_eq!(client.next_nonce(&owner_a), 1);
    assert_eq!(client.next_nonce(&owner_b), 1);
    assert_eq!(client.get(&owner_b, &0), Some(record_b));
    assert_ne!(
        client.get(&owner_a, &0).unwrap().manifest_hash,
        client.get(&owner_b, &0).unwrap().manifest_hash
    );
}

#[test]
fn every_state_mutation_requires_the_record_owner() {
    let (env, contract_id, owner) = setup();
    let client = KletiaPolicyReceiptRegistryClient::new(&env, &contract_id);

    commit_default(&env, &contract_id, &owner, 0);
    assert_eq!(env.auths().len(), 1);
    assert_eq!(env.auths()[0].0, owner);

    client.extend_ttl(&owner, &0, &(START_LEDGER + 2_000));
    assert_eq!(env.auths().len(), 1);
    assert_eq!(env.auths()[0].0, owner);

    client.finalize(&owner, &0, &hash(&env, 9));
    assert_eq!(env.auths().len(), 1);
    assert_eq!(env.auths()[0].0, owner);

    commit_default(&env, &contract_id, &owner, 1);
    client.cancel(&owner, &1);
    assert_eq!(env.auths().len(), 1);
    assert_eq!(env.auths()[0].0, owner);
}
