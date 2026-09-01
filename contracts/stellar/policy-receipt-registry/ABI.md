# Kletia Policy Receipt Registry ABI

This document describes the source ABI for the package-local contract. It does
not identify a deployment. Contract IDs, network passphrases, WASM hashes, and
source revisions belong in a signed deployment manifest.

The registry is an opaque, owner-authorized commitment anchor. It does not hold
funds, execute policies, verify receipt preimages, prove privacy, or verify
Stellar, EVM, CCTP, bridge, protocol, solver, or AI outcomes.

## Types

```text
RecordStatus = Active | Finalized | Cancelled

EffectiveStatus =
    Active
  | ExecutionExpiredAwaitingReceipt
  | ReceiptWindowClosed
  | Finalized
  | Cancelled

PolicyRecord = {
  owner: Address,
  nonce: u64,
  manifest_hash: BytesN<32>,
  privacy_budget_hash: BytesN<32>,
  receipt_hash: Option<BytesN<32>>,
  status: RecordStatus,
  committed_at_ledger: u32,
  execution_expires_at_ledger: u32,
  receipt_close_by_ledger: u32,
  updated_at_ledger: u32,
  retention_floor_ledger: u32
}
```

`RecordStatus::Active` is stored state. Consumers must use
`effective_status(...)` or apply the same ledger-relative rules before treating
a policy as execution-capable.

## Read methods

```text
next_nonce(owner: Address) -> u64
get(owner: Address, nonce: u64) -> Option<PolicyRecord>
effective_status(owner: Address, nonce: u64) -> Option<EffectiveStatus>
is_active(owner: Address, nonce: u64) -> bool
can_finalize(owner: Address, nonce: u64) -> bool
```

`is_active` is true only while stored status is `Active` and the current ledger
is strictly less than `execution_expires_at_ledger`.

`can_finalize` is true only while stored status is `Active` and the current
ledger is strictly less than `receipt_close_by_ledger`. It may therefore remain
true after `is_active` becomes false. It is not execution authorization.

## Owner-authorized methods

```text
commit(
  owner: Address,
  nonce: u64,
  manifest_hash: BytesN<32>,
  privacy_budget_hash: BytesN<32>,
  execution_expires_at_ledger: u32,
  receipt_close_by_ledger: u32,
  retention_floor_ledger: u32
) -> Result<PolicyRecord, RegistryError>

finalize(
  owner: Address,
  nonce: u64,
  receipt_hash: BytesN<32>
) -> Result<PolicyRecord, RegistryError>

cancel(
  owner: Address,
  nonce: u64
) -> Result<PolicyRecord, RegistryError>

extend_ttl(
  owner: Address,
  nonce: u64,
  retention_floor_ledger: u32
) -> Result<PolicyRecord, RegistryError>
```

Every mutating method invokes `owner.require_auth()` over the exact contract
invocation and arguments.

Commit requires:

- exact next owner nonce;
- non-zero manifest and privacy-budget hashes;
- `current_ledger < execution_expires_at_ledger`;
- `execution_expires_at_ledger < receipt_close_by_ledger`;
- `receipt_close_by_ledger <= retention_floor_ledger`; and
- all requested horizons to fit the network maximum persistent-entry TTL.

Finalize binds one non-zero opaque receipt hash once. It is allowed before the
receipt-close boundary even if execution validity has already expired. It sets
stored status to `Finalized` and cannot reactivate or authorize execution.

Cancel is allowed only before execution expiry. TTL extension changes only the
retention floor and cannot change either lifecycle deadline or any hash.

## Effective lifecycle

For a stored `Active` record at current ledger `L`:

```text
L < execution_expires_at_ledger
  => Active

execution_expires_at_ledger <= L < receipt_close_by_ledger
  => ExecutionExpiredAwaitingReceipt

receipt_close_by_ledger <= L
  => ReceiptWindowClosed
```

Both deadlines are exclusive. `Finalized` and `Cancelled` stored statuses take
precedence over ledger-derived states.

## Errors

| Code | Name | Meaning |
| ---: | --- | --- |
| 1 | `InvalidNonce` | Nonce is not the owner's exact next nonce |
| 2 | `NonceExhausted` | The supplied nonce cannot be incremented |
| 3 | `InvalidExpiry` | Execution expiry is not in the future |
| 4 | `BeyondMaximumTtl` | Requested horizon exceeds network maximum TTL |
| 5 | `RecordAlreadyExists` | Owner/nonce record key already exists |
| 6 | `RecordNotFound` | Retained owner/nonce record is absent |
| 7 | `RecordNotActive` | Stored record is already terminal |
| 8 | `PolicyExpired` | Execution-validity boundary has been reached |
| 9 | `InvalidRetention` | Retention floor is invalid, too short, or not extended |
| 10 | `InvalidHash` | A supplied 32-byte hash is all zeroes |
| 11 | `InvalidReceiptDeadline` | Receipt close is not later than execution expiry |
| 12 | `ReceiptWindowClosed` | Receipt-close boundary has been reached |

## Events

```text
policy_committed(
  owner: Address [topic],
  nonce: u64 [topic],
  manifest_hash: BytesN<32>,
  privacy_budget_hash: BytesN<32>,
  execution_expires_at_ledger: u32,
  receipt_close_by_ledger: u32,
  retention_floor_ledger: u32
)

policy_finalized(
  owner: Address [topic],
  nonce: u64 [topic],
  receipt_hash: BytesN<32>,
  finalized_at_ledger: u32
)

policy_cancelled(
  owner: Address [topic],
  nonce: u64 [topic],
  cancelled_at_ledger: u32
)

ttl_extended(
  owner: Address [topic],
  nonce: u64 [topic],
  retention_floor_ledger: u32
)
```

Events and stored hashes are public durable linkage. Hashing low-entropy values
does not make them confidential; canonical domain separation and unpredictable
blinding are integration responsibilities.
