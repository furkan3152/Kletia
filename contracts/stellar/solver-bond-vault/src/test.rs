extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token, Address, BytesN, Env,
};

struct Fixture {
    env: Env,
    client: KletiaSolverBondVaultClient<'static>,
    token: token::Client<'static>,
    issuer: token::StellarAssetClient<'static>,
    solver: Address,
    coordinator: Address,
    treasury: Address,
}

fn hash(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

fn fixture() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();
    let administrator = Address::generate(&env);
    let coordinator = Address::generate(&env);
    let treasury = Address::generate(&env);
    let solver = Address::generate(&env);
    let asset = env.register_stellar_asset_contract_v2(administrator.clone());
    let token_address = asset.address();
    let contract = env.register(
        KletiaSolverBondVault,
        (
            administrator,
            coordinator.clone(),
            treasury.clone(),
            token_address.clone(),
            1_000_i128,
            100_u32,
        ),
    );
    let client = KletiaSolverBondVaultClient::new(&env, &contract);
    let token = token::Client::new(&env, &token_address);
    let issuer = token::StellarAssetClient::new(&env, &token_address);
    issuer.mint(&solver, &20_000);
    Fixture {
        env,
        client,
        token,
        issuer,
        solver,
        coordinator,
        treasury,
    }
}

#[test]
fn register_lock_release_and_withdraw_preserve_asset_backing() {
    let fixture = fixture();
    let workflow = hash(&fixture.env, 11);
    let resolution = hash(&fixture.env, 12);
    let contract_address = fixture.client.address.clone();
    fixture
        .client
        .register(&fixture.solver, &hash(&fixture.env, 1), &5_000);
    assert_eq!(fixture.token.balance(&contract_address), 5_000);
    fixture
        .client
        .lock(&fixture.solver, &workflow, &2_000, &5_000);
    assert_eq!(fixture.client.available_bond(&fixture.solver), 3_000);
    fixture
        .client
        .release(&fixture.solver, &workflow, &resolution);
    assert_eq!(fixture.client.available_bond(&fixture.solver), 5_000);
    fixture.client.set_active(&fixture.solver, &false);
    fixture
        .client
        .withdraw(&fixture.solver, &fixture.solver, &5_000);
    assert_eq!(fixture.token.balance(&contract_address), 0);
    assert_eq!(fixture.token.balance(&fixture.solver), 20_000);
}

#[test]
fn slash_moves_the_exact_locked_asset_and_deactivates_undercollateralized_solver() {
    let fixture = fixture();
    let workflow = hash(&fixture.env, 21);
    fixture
        .client
        .register(&fixture.solver, &hash(&fixture.env, 2), &2_000);
    fixture
        .client
        .lock(&fixture.solver, &workflow, &1_500, &5_000);
    fixture
        .client
        .slash(&fixture.solver, &workflow, &hash(&fixture.env, 22));
    let position = fixture.client.position(&fixture.solver).unwrap();
    assert_eq!(position.total_bond, 500);
    assert_eq!(position.locked_bond, 0);
    assert_eq!(position.status, SolverStatus::Inactive);
    assert_eq!(fixture.token.balance(&fixture.treasury), 1_500);
}

#[test]
#[should_panic(expected = "Error(Contract, #8)")]
fn cannot_lock_more_than_unlocked_balance() {
    let fixture = fixture();
    fixture
        .client
        .register(&fixture.solver, &hash(&fixture.env, 3), &1_000);
    fixture
        .client
        .lock(&fixture.solver, &hash(&fixture.env, 31), &1_001, &5_000);
}

#[test]
#[should_panic(expected = "Error(Contract, #14)")]
fn active_solver_cannot_withdraw() {
    let fixture = fixture();
    fixture
        .client
        .register(&fixture.solver, &hash(&fixture.env, 4), &1_000);
    fixture
        .client
        .withdraw(&fixture.solver, &fixture.solver, &1_000);
}

#[test]
#[should_panic(expected = "Error(Contract, #12)")]
fn resolved_lock_cannot_be_replayed() {
    let fixture = fixture();
    let workflow = hash(&fixture.env, 41);
    let resolution = hash(&fixture.env, 42);
    fixture
        .client
        .register(&fixture.solver, &hash(&fixture.env, 5), &2_000);
    fixture
        .client
        .lock(&fixture.solver, &workflow, &1_000, &5_000);
    fixture
        .client
        .release(&fixture.solver, &workflow, &resolution);
    fixture
        .client
        .release(&fixture.solver, &workflow, &resolution);
}

#[test]
fn coordinator_and_treasury_are_immutable_configuration() {
    let fixture = fixture();
    let config = fixture.client.config();
    assert_eq!(config.coordinator, fixture.coordinator);
    assert_eq!(config.treasury, fixture.treasury);
    assert_eq!(config.minimum_bond, 1_000);
    assert_eq!(config.resolution_grace_ledgers, 100);
    assert_eq!(fixture.issuer.balance(&fixture.solver), 20_000);
}

#[test]
fn solver_can_reclaim_only_after_the_immutable_grace_window() {
    let fixture = fixture();
    let workflow = hash(&fixture.env, 51);
    fixture
        .client
        .register(&fixture.solver, &hash(&fixture.env, 52), &2_000);
    fixture
        .client
        .lock(&fixture.solver, &workflow, &1_000, &500);
    let lock = fixture
        .client
        .bond_lock(&fixture.solver, &workflow)
        .unwrap();
    assert_eq!(lock.reclaim_after_ledger, 600);
    fixture.env.ledger().set_sequence_number(601);
    let reclaimed =
        fixture
            .client
            .reclaim_expired(&fixture.solver, &workflow, &hash(&fixture.env, 53));
    assert_eq!(reclaimed.status, BondLockStatus::Released);
    assert_eq!(fixture.client.available_bond(&fixture.solver), 2_000);
}

#[test]
#[should_panic(expected = "Error(Contract, #18)")]
fn solver_cannot_reclaim_during_resolution_grace() {
    let fixture = fixture();
    let workflow = hash(&fixture.env, 61);
    fixture
        .client
        .register(&fixture.solver, &hash(&fixture.env, 62), &2_000);
    fixture
        .client
        .lock(&fixture.solver, &workflow, &1_000, &500);
    fixture.env.ledger().set_sequence_number(600);
    fixture
        .client
        .reclaim_expired(&fixture.solver, &workflow, &hash(&fixture.env, 63));
}
