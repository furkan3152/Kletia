#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

verify_contract() {
  local package_dir="$1"
  local artifact_name="$2"
  local label="$3"
  local lock_key="$4"
  local contract_root="$repository_root/contracts/stellar/$package_dir"
  local artifact="$contract_root/target/wasm32v1-none/release/$artifact_name"

  cd "$contract_root"
  cargo fmt -- --check
  cargo clippy --all-targets --locked -- -D warnings
  cargo test --locked
  cargo build --target wasm32v1-none --release --locked

  if [[ ! -s "$artifact" ]]; then
    echo "$label WASM was not produced: $artifact" >&2
    exit 1
  fi

  local artifact_size
  local artifact_sha256
  artifact_size="$(wc -c < "$artifact" | tr -d ' ')"
  artifact_sha256="$(sha256sum "$artifact" | cut -d ' ' -f 1)"
  local expected_sha256
  expected_sha256="$(node -e 'const lock=require(process.argv[1]); const artifact=lock.sourceArtifacts[process.argv[2]]; if (!artifact?.releaseWasmSha256) process.exit(2); process.stdout.write(artifact.releaseWasmSha256)' "$repository_root/contracts/stellar/protocol.lock.json" "$lock_key")"
  if [[ "$artifact_sha256" != "$expected_sha256" ]]; then
    echo "$label release hash drifted: expected=$expected_sha256 observed=$artifact_sha256" >&2
    exit 1
  fi
  echo "$label verified: ${artifact_size} bytes, sha256=${artifact_sha256}"
}

verify_contract \
  "policy-receipt-registry" \
  "kletia_policy_receipt_registry.wasm" \
  "Policy receipt registry" \
  "policyReceiptRegistry"
verify_contract \
  "intent-control-plane" \
  "kletia_intent_control_plane.wasm" \
  "Intent control plane" \
  "intentControlPlane"
verify_contract \
  "intent-control-plane-v2" \
  "kletia_intent_control_plane_v2.wasm" \
  "Intent control plane V2" \
  "intentControlPlaneV2"
verify_contract \
  "policy-verifier-registry" \
  "kletia_policy_verifier_registry.wasm" \
  "Policy verifier registry" \
  "policyVerifierRegistry"
verify_contract \
  "policy-groth16-verifier" \
  "kletia_policy_groth16_verifier.wasm" \
  "Policy Groth16 verifier" \
  "policyGroth16Verifier"
verify_contract \
  "solver-bond-vault" \
  "kletia_solver_bond_vault.wasm" \
  "Solver bond vault" \
  "solverBondVault"
verify_contract \
  "route-auction" \
  "kletia_route_auction.wasm" \
  "Route auction" \
  "routeAuction"
