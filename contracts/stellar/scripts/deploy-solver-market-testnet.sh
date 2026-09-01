#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
vault_root="$repository_root/contracts/stellar/solver-bond-vault"
auction_root="$repository_root/contracts/stellar/route-auction"
vault_wasm="$vault_root/target/wasm32v1-none/release/kletia_solver_bond_vault.wasm"
auction_wasm="$auction_root/target/wasm32v1-none/release/kletia_route_auction.wasm"
protocol_lock="$repository_root/contracts/stellar/protocol.lock.json"

require_value() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required environment variable: $name" >&2
    exit 1
  fi
}

require_public_address() {
  local name="$1"
  local value="${!name}"
  if [[ ! "$value" =~ ^[CG][A-Z2-7]{55}$ ]]; then
    echo "$name must be a public Stellar G-account or contract ID." >&2
    exit 1
  fi
}

require_value KLETIA_STELLAR_DEPLOYER_ALIAS
require_value KLETIA_SOLVER_MARKET_ADMINISTRATOR
require_value KLETIA_SOLVER_MARKET_COORDINATOR
require_value KLETIA_SOLVER_MARKET_TREASURY
require_value KLETIA_SOLVER_MARKET_BOND_ASSET
require_value KLETIA_SOLVER_MARKET_MINIMUM_BOND_ATOMIC
require_value KLETIA_SOLVER_MARKET_RESOLUTION_GRACE_LEDGERS

require_public_address KLETIA_SOLVER_MARKET_ADMINISTRATOR
require_public_address KLETIA_SOLVER_MARKET_COORDINATOR
require_public_address KLETIA_SOLVER_MARKET_TREASURY
require_public_address KLETIA_SOLVER_MARKET_BOND_ASSET

if [[ ! "$KLETIA_SOLVER_MARKET_MINIMUM_BOND_ATOMIC" =~ ^[1-9][0-9]*$ ]]; then
  echo "KLETIA_SOLVER_MARKET_MINIMUM_BOND_ATOMIC must be a positive atomic integer." >&2
  exit 1
fi
if [[ ! "$KLETIA_SOLVER_MARKET_RESOLUTION_GRACE_LEDGERS" =~ ^[1-9][0-9]*$ ]] ||
  (( KLETIA_SOLVER_MARKET_RESOLUTION_GRACE_LEDGERS > 120960 )); then
  echo "KLETIA_SOLVER_MARKET_RESOLUTION_GRACE_LEDGERS must be between 1 and 120960." >&2
  exit 1
fi

stellar_version="$(stellar --version | head -n 1)"
if [[ "$stellar_version" != stellar\ 27.1.0* ]]; then
  echo "Expected Stellar CLI 27.1.0; observed: $stellar_version" >&2
  exit 1
fi

deployer_address="$(stellar keys address "$KLETIA_STELLAR_DEPLOYER_ALIAS")"
if [[ ! "$deployer_address" =~ ^G[A-Z2-7]{55}$ ]]; then
  echo "The deployer alias did not resolve to a public Stellar account." >&2
  exit 1
fi

cargo +1.91.0 fmt --manifest-path "$vault_root/Cargo.toml" -- --check
cargo +1.91.0 clippy --manifest-path "$vault_root/Cargo.toml" --all-targets --locked -- -D warnings
cargo +1.91.0 test --manifest-path "$vault_root/Cargo.toml" --locked
cargo +1.91.0 build --manifest-path "$vault_root/Cargo.toml" --target wasm32v1-none --release --locked
cargo +1.91.0 fmt --manifest-path "$auction_root/Cargo.toml" -- --check
cargo +1.91.0 clippy --manifest-path "$auction_root/Cargo.toml" --all-targets --locked -- -D warnings
cargo +1.91.0 test --manifest-path "$auction_root/Cargo.toml" --locked
cargo +1.91.0 build --manifest-path "$auction_root/Cargo.toml" --target wasm32v1-none --release --locked

expected_vault_hash="$(node -e 'const lock=require(process.argv[1]); process.stdout.write(lock.sourceArtifacts.solverBondVault.releaseWasmSha256)' "$protocol_lock")"
expected_auction_hash="$(node -e 'const lock=require(process.argv[1]); process.stdout.write(lock.sourceArtifacts.routeAuction.releaseWasmSha256)' "$protocol_lock")"
observed_vault_hash="$(sha256sum "$vault_wasm" | cut -d ' ' -f 1)"
observed_auction_hash="$(sha256sum "$auction_wasm" | cut -d ' ' -f 1)"
if [[ "$expected_vault_hash" != "$observed_vault_hash" ]] ||
  [[ "$expected_auction_hash" != "$observed_auction_hash" ]]; then
  echo "Release WASM hash drifted; deployment refused." >&2
  exit 1
fi

if [[ "${KLETIA_CONFIRM_TESTNET_DEPLOY:-}" != "DEPLOY_STELLAR_TESTNET_SOLVER_MARKET" ]]; then
  echo "Preflight passed for deployer $deployer_address."
  echo "No transaction was sent. Set KLETIA_CONFIRM_TESTNET_DEPLOY=DEPLOY_STELLAR_TESTNET_SOLVER_MARKET to deploy."
  exit 0
fi

# The release lock pins the raw Rust WASM. `--optimize=false` is mandatory;
# deploying the CLI-optimized artifact would create a different executable hash
# and runtime readiness would correctly quarantine it.
vault_contract_id="$(stellar -q contract deploy \
  --wasm "$vault_wasm" \
  --optimize=false \
  --source-account "$KLETIA_STELLAR_DEPLOYER_ALIAS" \
  --network testnet \
  -- \
  --administrator "$KLETIA_SOLVER_MARKET_ADMINISTRATOR" \
  --coordinator "$KLETIA_SOLVER_MARKET_COORDINATOR" \
  --treasury "$KLETIA_SOLVER_MARKET_TREASURY" \
  --bond-asset "$KLETIA_SOLVER_MARKET_BOND_ASSET" \
  --minimum-bond "$KLETIA_SOLVER_MARKET_MINIMUM_BOND_ATOMIC" \
  --resolution-grace-ledgers "$KLETIA_SOLVER_MARKET_RESOLUTION_GRACE_LEDGERS")"

auction_contract_id="$(stellar -q contract deploy \
  --wasm "$auction_wasm" \
  --optimize=false \
  --source-account "$KLETIA_STELLAR_DEPLOYER_ALIAS" \
  --network testnet \
  -- \
  --bond-vault "$vault_contract_id" \
  --settlement-authority "$KLETIA_SOLVER_MARKET_COORDINATOR" \
  --max-bids 32)"

if [[ ! "$vault_contract_id" =~ ^C[A-Z2-7]{55}$ ]] ||
  [[ ! "$auction_contract_id" =~ ^C[A-Z2-7]{55}$ ]]; then
  echo "Deployment returned an invalid contract ID." >&2
  exit 1
fi

stellar contract invoke \
  --id "$vault_contract_id" \
  --source-account "$deployer_address" \
  --network testnet \
  --send no \
  -- config >/dev/null
stellar contract invoke \
  --id "$auction_contract_id" \
  --source-account "$deployer_address" \
  --network testnet \
  --send no \
  -- config >/dev/null

echo "STELLAR_SOLVER_BOND_VAULT_TESTNET_CONTRACT_ID=$vault_contract_id"
echo "STELLAR_ROUTE_AUCTION_TESTNET_CONTRACT_ID=$auction_contract_id"
echo "Deployment sent and both config getters simulated. Enable STELLAR_SOLVER_MARKET_ENABLED only after the manifest, live runtime hashes, immutable bindings and a full bonded auction lifecycle are independently checked."
