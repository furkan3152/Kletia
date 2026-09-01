#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
release_lock="$repository_root/contracts/stellar/control-plane-v2.lock.json"
deployment_manifest="$repository_root/contracts/stellar/deployments/testnet/control-plane.v2.json"
verifier_root="$repository_root/contracts/stellar/policy-groth16-verifier"
registry_root="$repository_root/contracts/stellar/policy-verifier-registry"
control_root="$repository_root/contracts/stellar/intent-control-plane-v2"
verifier_wasm="$verifier_root/target/wasm32v1-none/release/kletia_policy_groth16_verifier.wasm"
registry_wasm="$registry_root/target/wasm32v1-none/release/kletia_policy_verifier_registry.wasm"
control_wasm="$control_root/target/wasm32v1-none/release/kletia_intent_control_plane_v2.wasm"
constructor_json="$repository_root/circuits/stellar-policy/build-v2/testnet-deployment/verifier-constructor.json"

require_value() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required environment variable: $name" >&2
    exit 1
  fi
}

json_value() {
  node -e 'const value=require(process.argv[1]); const path=process.argv[2].split("."); let current=value; for (const key of path) current=current[key]; process.stdout.write(String(current));' "$release_lock" "$1"
}

require_contract_id() {
  local name="$1"
  local value="${!name}"
  if [[ ! "$value" =~ ^C[A-Z2-7]{55}$ ]]; then
    echo "$name must be a public Stellar contract ID." >&2
    exit 1
  fi
}

require_value KLETIA_STELLAR_DEPLOYER_ALIAS
if [[ -f "$deployment_manifest" ]] &&
  [[ "${KLETIA_FORCE_NEW_POLICY_V2_TESTNET_DEPLOYMENT:-}" != "I_ACCEPT_A_DISTINCT_POLICY_V2_TESTNET_RELEASE" ]]; then
  node -e '
    const manifest=require(process.argv[1]);
    console.log(`Policy V2 is already recorded as deployed: ${manifest.artifacts.intentControlPlaneV2.contractId}`);
    console.log(`Verifier registry: ${manifest.artifacts.policyVerifierRegistry.contractId}`);
    console.log(`Immutable verifier: ${manifest.artifacts.policyGroth16Verifier.contractId}`);
    console.log("No transaction was sent. Use the live-readiness probe instead of redeploying the same release.");
  ' "$deployment_manifest"
  exit 0
fi
if [[ -n "${KLETIA_POLICY_V2_EXISTING_REGISTRY_TESTNET_CONTRACT_ID:-}" ]]; then
  require_contract_id KLETIA_POLICY_V2_EXISTING_REGISTRY_TESTNET_CONTRACT_ID
fi

stellar_version="$(stellar --version | head -n 1)"
if [[ "$stellar_version" != stellar\ 27.1.0* ]]; then
  echo "Expected Stellar CLI 27.1.0; observed: $stellar_version" >&2
  exit 1
fi

deployer_address="$(stellar keys address "$KLETIA_STELLAR_DEPLOYER_ALIAS")"
if [[ ! "$deployer_address" =~ ^G[A-Z2-7]{55}$ ]]; then
  echo "The deployer alias did not resolve to a public Stellar G-account." >&2
  exit 1
fi

registry_contract_id="${KLETIA_POLICY_V2_EXISTING_REGISTRY_TESTNET_CONTRACT_ID:-}"
if [[ -n "$registry_contract_id" ]]; then
  registry_admin="$(stellar -q contract invoke \
    --id "$registry_contract_id" \
    --source-account "$deployer_address" \
    --network testnet \
    --send no \
    -- admin | tr -d '\"[:space:]')"
  if [[ "$registry_admin" != "$deployer_address" ]]; then
    echo "The selected deployer is not the live Policy V2 Verifier Registry administrator." >&2
    exit 1
  fi
  existing_version="$(stellar -q contract invoke \
    --id "$registry_contract_id" \
    --source-account "$deployer_address" \
    --network testnet \
    --send no \
    -- get --version 2 | tr -d '[:space:]')"
  if [[ "$existing_version" != "null" ]]; then
    echo "Verifier version 2 already exists in the selected registry; refusing a duplicate deployment." >&2
    echo "Attest the existing record and configure its exact verifier/control-plane identities instead." >&2
    exit 1
  fi
fi

for contract_root in "$verifier_root" "$registry_root" "$control_root"; do
  cargo +1.91.0 fmt --manifest-path "$contract_root/Cargo.toml" -- --check
  cargo +1.91.0 clippy --manifest-path "$contract_root/Cargo.toml" --all-targets --locked -- -D warnings
  cargo +1.91.0 test --manifest-path "$contract_root/Cargo.toml" --locked
  cargo +1.91.0 build --manifest-path "$contract_root/Cargo.toml" --target wasm32v1-none --release --locked
done

check_hash() {
  local file="$1"
  local expected="$2"
  local observed
  observed="$(sha256sum "$file" | cut -d ' ' -f 1)"
  if [[ "$observed" != "$expected" ]]; then
    echo "Release artifact drifted: $file" >&2
    echo "Expected $expected; observed $observed" >&2
    exit 1
  fi
}

check_hash "$verifier_wasm" "$(json_value artifacts.policyGroth16Verifier.releaseWasmSha256)"
check_hash "$registry_wasm" "$(json_value artifacts.policyVerifierRegistry.releaseWasmSha256)"
check_hash "$control_wasm" "$(json_value artifacts.intentControlPlaneV2.releaseWasmSha256)"
check_hash "$repository_root/circuits/stellar-policy/KletiaPolicyV2.circom" "$(json_value policyCircuit.sourceSha256)"
check_hash "$repository_root/circuits/stellar-policy/public-inputs.v2.json" "$(json_value policyCircuit.publicInputManifestSha256)"
check_hash "$repository_root/circuits/stellar-policy/build-v2/KletiaPolicyV2.r1cs" "$(json_value policyCircuit.r1csSha256)"
check_hash "$repository_root/circuits/stellar-policy/build-v2/KletiaPolicyV2_js/KletiaPolicyV2.wasm" "$(json_value policyCircuit.proverWasmSha256)"
check_hash "$repository_root/circuits/stellar-policy/build-v2/testnet-deployment/kletia_policy_v2_testnet_final.zkey" "$(json_value policyCircuit.finalZkeySha256)"
check_hash "$repository_root/circuits/stellar-policy/build-v2/testnet-deployment/verification_key.json" "$(json_value policyCircuit.snarkjsVerificationKeySha256)"
check_hash "$constructor_json" "$(json_value policyCircuit.constructorSha256)"

constructor_vk_hash="$(node -e 'const value=require(process.argv[1]); process.stdout.write(value.verificationKeySha256)' "$constructor_json.manifest.json")"
if [[ "$constructor_vk_hash" != "$(json_value policyCircuit.verificationKeySha256)" ]]; then
  echo "The verifier constructor no longer encodes the pinned verification key." >&2
  exit 1
fi

retention_ledgers="${KLETIA_POLICY_V2_RETENTION_LEDGERS:-500000}"
if [[ ! "$retention_ledgers" =~ ^[1-9][0-9]*$ ]]; then
  echo "KLETIA_POLICY_V2_RETENTION_LEDGERS must be a positive ledger count." >&2
  exit 1
fi

if [[ "${KLETIA_CONFIRM_TESTNET_DEPLOY:-}" != "DEPLOY_STELLAR_TESTNET_POLICY_V2" ]]; then
  echo "Policy V2 release preflight passed for deployer $deployer_address."
  if [[ -z "$registry_contract_id" ]]; then
    echo "A dedicated Policy V2 Verifier Registry will be deployed and initialized to that account."
  else
    echo "Existing Policy V2 Verifier Registry selected: $registry_contract_id"
  fi
  echo "No transaction was sent. Set KLETIA_CONFIRM_TESTNET_DEPLOY=DEPLOY_STELLAR_TESTNET_POLICY_V2 to deploy and register version 2."
  exit 0
fi

if [[ -z "$registry_contract_id" ]]; then
  registry_contract_id="$(stellar -q contract deploy \
    --wasm "$registry_wasm" \
    --optimize=false \
    --source-account "$KLETIA_STELLAR_DEPLOYER_ALIAS" \
    --network testnet)"
  if [[ ! "$registry_contract_id" =~ ^C[A-Z2-7]{55}$ ]]; then
    echo "Policy V2 Verifier Registry deployment returned an invalid contract ID." >&2
    exit 1
  fi
  echo "Deployed Policy V2 Verifier Registry: $registry_contract_id" >&2
  stellar -q contract invoke \
    --id "$registry_contract_id" \
    --source-account "$KLETIA_STELLAR_DEPLOYER_ALIAS" \
    --network testnet \
    --send yes \
    -- initialize --admin "$deployer_address" >/dev/null
fi

verifier_contract_id="$(stellar -q contract deploy \
  --wasm "$verifier_wasm" \
  --optimize=false \
  --source-account "$KLETIA_STELLAR_DEPLOYER_ALIAS" \
  --network testnet \
  -- \
  --verification_key-file-path "$constructor_json")"
if [[ ! "$verifier_contract_id" =~ ^C[A-Z2-7]{55}$ ]]; then
  echo "Verifier deployment returned an invalid contract ID." >&2
  exit 1
fi
echo "Deployed immutable Policy V2 verifier: $verifier_contract_id" >&2

control_plane_contract_id="$(stellar -q contract deploy \
  --wasm "$control_wasm" \
  --optimize=false \
  --source-account "$KLETIA_STELLAR_DEPLOYER_ALIAS" \
  --network testnet \
  -- \
  --verifier_registry "$registry_contract_id")"
if [[ ! "$control_plane_contract_id" =~ ^C[A-Z2-7]{55}$ ]]; then
  echo "Intent Control Plane V2 deployment returned an invalid contract ID." >&2
  exit 1
fi
echo "Deployed Intent Control Plane V2: $control_plane_contract_id" >&2

observed_binding="$(stellar -q contract invoke \
  --id "$control_plane_contract_id" \
  --source-account "$deployer_address" \
  --network testnet \
  --send no \
  -- verifier_registry | tr -d '\"[:space:]')"
if [[ "$observed_binding" != "$registry_contract_id" ]]; then
  echo "The deployed control plane does not bind the selected verifier registry." >&2
  exit 1
fi

stellar -q contract invoke \
  --id "$registry_contract_id" \
  --source-account "$KLETIA_STELLAR_DEPLOYER_ALIAS" \
  --network testnet \
  --send yes \
  -- register \
  --version 2 \
  --verifier "$verifier_contract_id" \
  --vk_hash "$(json_value policyCircuit.verificationKeySha256)" \
  --circuit_hash "$(json_value policyCircuit.sourceSha256)" \
  --public_input_schema_hash "$(json_value policyCircuit.publicInputManifestSha256)" \
  --public_input_count "$(json_value policyCircuit.publicInputCount)" \
  --lane_input_index "$(json_value policyCircuit.laneInputIndex)" \
  --expiry_ledger_input_index "$(json_value policyCircuit.expiryLedgerInputIndex)" \
  --retention_ledgers "$retention_ledgers" >/dev/null

echo "STELLAR_INTENT_CONTROL_PLANE_V2_TESTNET_CONTRACT_ID=$control_plane_contract_id"
echo "STELLAR_POLICY_V2_VERIFIER_TESTNET_CONTRACT_ID=$verifier_contract_id"
echo "STELLAR_POLICY_V2_VERIFIER_REGISTRY_TESTNET_CONTRACT_ID=$registry_contract_id"
echo "STELLAR_POLICY_V2_VERIFIER_VERSION=2"
echo "STELLAR_POLICY_V2_VERIFICATION_KEY_SHA256=$(json_value policyCircuit.verificationKeySha256)"
echo "Deployment and registry binding completed. Keep both V2 capability flags false until live readiness and a real owner-signed commit/finalize lifecycle pass."
