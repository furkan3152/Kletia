extern crate std;

use super::*;
use kletia_solver_bond_vault::{KletiaSolverBondVault, KletiaSolverBondVaultClient};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token, Address, BytesN, Env,
};

struct Fixture {
    env: Env,
    auction: KletiaRouteAuctionClient<'static>,
    vault: KletiaSolverBondVaultClient<'static>,
    issuer: token::StellarAssetClient<'static>,
    owner: Address,
    authority: Address,
    first_solver: Address,
    second_solver: Address,
}

fn hash(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

fn fixture() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_sequence_number(100);
    let owner = Address::generate(&env);
    let authority = Address::generate(&env);
    let treasury = Address::generate(&env);
    let first_solver = Address::generate(&env);
    let second_solver = Address::generate(&env);
    let asset_admin = Address::generate(&env);
    let asset = env.register_stellar_asset_contract_v2(asset_admin);
    let asset_address = asset.address();
    let issuer = token::StellarAssetClient::new(&env, &asset_address);
    issuer.mint(&first_solver, &10_000);
    issuer.mint(&second_solver, &10_000);
    let vault_address = env.register(
        KletiaSolverBondVault,
        (
            Address::generate(&env),
            authority.clone(),
            treasury,
            asset_address,
            1_000_i128,
            100_u32,
        ),
    );
    let vault = KletiaSolverBondVaultClient::new(&env, &vault_address);
    let auction_address = env.register(
        KletiaRouteAuction,
        (vault_address, authority.clone(), 8_u32),
    );
    let auction = KletiaRouteAuctionClient::new(&env, &auction_address);
    Fixture {
        env,
        auction,
        vault,
        issuer,
        owner,
        authority,
        first_solver,
        second_solver,
    }
}

fn open(fixture: &Fixture, workflow: &BytesN<32>, minimum_bond: i128) {
    fixture.auction.open(
        &fixture.owner,
        workflow,
        &hash(&fixture.env, 2),
        &1_000,
        &100,
        &900,
        &minimum_bond,
        &120,
        &140,
        &400,
    );
}

fn register_and_lock(fixture: &Fixture, solver: &Address, workflow: &BytesN<32>, amount: i128) {
    fixture
        .vault
        .register(solver, &hash(&fixture.env, 3), &5_000);
    fixture.vault.lock(solver, workflow, &amount, &400);
}

#[allow(clippy::too_many_arguments)]
fn commit_and_reveal(
    fixture: &Fixture,
    solver: &Address,
    workflow: &BytesN<32>,
    route_byte: u8,
    output: i128,
    fee: i128,
    duration: u64,
    quote_expiry: u32,
    salt_byte: u8,
) {
    let route = hash(&fixture.env, route_byte);
    let evidence = hash(&fixture.env, route_byte.saturating_add(20));
    let salt = hash(&fixture.env, salt_byte);
    let commitment = fixture.auction.compute_commitment(
        workflow,
        solver,
        &route,
        &evidence,
        &output,
        &fee,
        &duration,
        &quote_expiry,
        &salt,
    );
    fixture.auction.commit_bid(solver, workflow, &commitment);
    fixture.env.ledger().set_sequence_number(121);
    fixture.auction.reveal_bid(
        solver,
        workflow,
        &route,
        &evidence,
        &output,
        &fee,
        &duration,
        &quote_expiry,
        &salt,
    );
}

#[test]
fn highest_net_output_wins_and_bond_is_rechecked() {
    let fixture = fixture();
    let workflow = hash(&fixture.env, 1);
    open(&fixture, &workflow, 2_000);
    register_and_lock(&fixture, &fixture.first_solver, &workflow, 2_000);
    register_and_lock(&fixture, &fixture.second_solver, &workflow, 2_000);

    let first_route = hash(&fixture.env, 10);
    let first_evidence = hash(&fixture.env, 30);
    let first_salt = hash(&fixture.env, 40);
    let first_commitment = fixture.auction.compute_commitment(
        &workflow,
        &fixture.first_solver,
        &first_route,
        &first_evidence,
        &1_250,
        &40,
        &400,
        &300,
        &first_salt,
    );
    fixture
        .auction
        .commit_bid(&fixture.first_solver, &workflow, &first_commitment);
    let second_route = hash(&fixture.env, 11);
    let second_evidence = hash(&fixture.env, 31);
    let second_salt = hash(&fixture.env, 41);
    let second_commitment = fixture.auction.compute_commitment(
        &workflow,
        &fixture.second_solver,
        &second_route,
        &second_evidence,
        &1_300,
        &50,
        &500,
        &300,
        &second_salt,
    );
    fixture
        .auction
        .commit_bid(&fixture.second_solver, &workflow, &second_commitment);

    fixture.env.ledger().set_sequence_number(121);
    fixture.auction.reveal_bid(
        &fixture.first_solver,
        &workflow,
        &first_route,
        &first_evidence,
        &1_250,
        &40,
        &400,
        &300,
        &first_salt,
    );
    fixture.auction.reveal_bid(
        &fixture.second_solver,
        &workflow,
        &second_route,
        &second_evidence,
        &1_300,
        &50,
        &500,
        &300,
        &second_salt,
    );
    fixture.env.ledger().set_sequence_number(141);
    let result = fixture.auction.finalize(&workflow);
    assert_eq!(result.status, AuctionStatus::Finalized);
    assert_eq!(result.winner, Some(fixture.second_solver));
    assert_eq!(result.winning_route_hash, Some(second_route));
    assert_eq!(result.winning_net_output, Some(1_250));
}

#[test]
#[should_panic(expected = "Error(Contract, #15)")]
fn changed_reveal_cannot_match_commitment() {
    let fixture = fixture();
    let workflow = hash(&fixture.env, 50);
    open(&fixture, &workflow, 1_000);
    register_and_lock(&fixture, &fixture.first_solver, &workflow, 1_000);
    let route = hash(&fixture.env, 51);
    let evidence = hash(&fixture.env, 52);
    let salt = hash(&fixture.env, 53);
    let commitment = fixture.auction.compute_commitment(
        &workflow,
        &fixture.first_solver,
        &route,
        &evidence,
        &1_200,
        &20,
        &300,
        &250,
        &salt,
    );
    fixture
        .auction
        .commit_bid(&fixture.first_solver, &workflow, &commitment);
    fixture.env.ledger().set_sequence_number(121);
    fixture.auction.reveal_bid(
        &fixture.first_solver,
        &workflow,
        &route,
        &evidence,
        &1_201,
        &20,
        &300,
        &250,
        &salt,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #17)")]
fn bid_requires_exact_workflow_bond() {
    let fixture = fixture();
    let workflow = hash(&fixture.env, 60);
    open(&fixture, &workflow, 2_000);
    register_and_lock(&fixture, &fixture.first_solver, &workflow, 1_000);
    fixture
        .auction
        .commit_bid(&fixture.first_solver, &workflow, &hash(&fixture.env, 61));
}

#[test]
fn stale_or_out_of_policy_bid_cannot_win() {
    let fixture = fixture();
    let workflow = hash(&fixture.env, 70);
    open(&fixture, &workflow, 1_000);
    register_and_lock(&fixture, &fixture.first_solver, &workflow, 1_000);
    commit_and_reveal(
        &fixture,
        &fixture.first_solver,
        &workflow,
        71,
        1_100,
        101,
        100,
        145,
        72,
    );
    let bid = fixture
        .auction
        .bid(&workflow, &fixture.first_solver)
        .unwrap();
    assert!(!bid.eligible);
    fixture.env.ledger().set_sequence_number(146);
    let result = fixture.auction.finalize(&workflow);
    assert_eq!(result.status, AuctionStatus::NoWinner);
    assert_eq!(result.winner, None);
}

#[test]
fn indeterminate_settlement_can_recover_without_immediate_fault() {
    let fixture = fixture();
    let workflow = hash(&fixture.env, 80);
    open(&fixture, &workflow, 1_000);
    register_and_lock(&fixture, &fixture.first_solver, &workflow, 1_000);
    commit_and_reveal(
        &fixture,
        &fixture.first_solver,
        &workflow,
        81,
        1_200,
        20,
        300,
        300,
        82,
    );
    fixture.env.ledger().set_sequence_number(141);
    fixture.auction.finalize(&workflow);
    let uncertain = fixture
        .auction
        .mark_indeterminate(&workflow, &hash(&fixture.env, 83));
    assert_eq!(uncertain.status, AuctionStatus::Indeterminate);
    let lock = fixture
        .vault
        .bond_lock(&fixture.first_solver, &workflow)
        .unwrap();
    assert_eq!(
        lock.status,
        kletia_solver_bond_vault::BondLockStatus::Locked
    );
    let recovered = fixture
        .auction
        .settle_success(&workflow, &hash(&fixture.env, 84));
    assert_eq!(recovered.status, AuctionStatus::Succeeded);
}

#[test]
fn empty_auction_can_be_cancelled_by_owner() {
    let fixture = fixture();
    let workflow = hash(&fixture.env, 90);
    open(&fixture, &workflow, 1_000);
    let result = fixture.auction.cancel(&workflow, &hash(&fixture.env, 91));
    assert_eq!(result.status, AuctionStatus::Cancelled);
    assert_eq!(result.result_hash, Some(hash(&fixture.env, 91)));
    let _ = &fixture.issuer;
    let _ = &fixture.authority;
}

#[test]
fn abandoned_finalized_auction_becomes_indeterminate_without_slashing() {
    let fixture = fixture();
    let workflow = hash(&fixture.env, 100);
    open(&fixture, &workflow, 1_000);
    register_and_lock(&fixture, &fixture.first_solver, &workflow, 1_000);
    commit_and_reveal(
        &fixture,
        &fixture.first_solver,
        &workflow,
        101,
        1_200,
        20,
        300,
        300,
        102,
    );
    fixture.env.ledger().set_sequence_number(141);
    fixture.auction.finalize(&workflow);
    fixture.env.ledger().set_sequence_number(401);
    let expired = fixture
        .auction
        .expire_unsettled(&workflow, &hash(&fixture.env, 103));
    assert_eq!(expired.status, AuctionStatus::Indeterminate);
    let lock = fixture
        .vault
        .bond_lock(&fixture.first_solver, &workflow)
        .unwrap();
    assert_eq!(
        lock.status,
        kletia_solver_bond_vault::BondLockStatus::Locked
    );
}

#[test]
fn bid_commitment_has_a_cross_sdk_release_vector() {
    let env = Env::default();
    let route_contract = Address::from_str(
        &env,
        "CCFY5ZJJ5CILIOPD7LUYRRQ3XCO2OUUL3ZMZQER4IWQ6XO7ZLVWBBP5D",
    );
    env.register_at(
        &route_contract,
        KletiaRouteAuction,
        (Address::generate(&env), Address::generate(&env), 8_u32),
    );
    let client = KletiaRouteAuctionClient::new(&env, &route_contract);
    let solver = Address::from_str(
        &env,
        "GDKHTBTURCFYXVNBRIXTUFGIS76TOZGBOA52VAYFKTMWXELDBGA4E5CN",
    );
    let commitment = client.compute_commitment(
        &hash(&env, 0x11),
        &solver,
        &hash(&env, 0x22),
        &hash(&env, 0x33),
        &1_234_567_i128,
        &1_234_i128,
        &321_u64,
        &987_654_u32,
        &hash(&env, 0x44),
    );
    assert_eq!(
        commitment,
        BytesN::from_array(
            &env,
            &[
                0x46, 0xf4, 0xff, 0x28, 0xbb, 0x98, 0x64, 0x73, 0x69, 0xcc, 0x77, 0xc7, 0x74, 0x82,
                0x8e, 0x16, 0x3b, 0x94, 0x14, 0x10, 0x80, 0x35, 0x75, 0x28, 0x67, 0xbb, 0xd3, 0xcd,
                0xff, 0x2c, 0x82, 0xaf,
            ],
        ),
    );
}
