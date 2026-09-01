# Kletia Policy Receipt Registry

`KletiaPolicyReceiptRegistry` is an opt-in, custody-free Soroban registry for
binding a wallet-approved workflow policy to a later execution-receipt hash.
It gives Kletia integrations a small on-chain anchor without turning an agent,
relayer, or backend into a custodian.

## Security boundary

The contract:

- stores an immutable `manifest_hash` and `privacy_budget_hash` under an owner
  address and monotonically increasing nonce;
- lets only that owner finalize the record with one `receipt_hash` before a
  separate receipt-close deadline, or cancel it while execution is active;
- enforces separate exclusive execution and receipt-close deadlines plus an
  explicit minimum persistent-storage horizon;
- emits typed events for commitment, finalization, cancellation, and TTL
  extension;
- never holds or transfers assets;
- never grants token approval, delegated spending, signing, upgrade, or agent
  authority; and
- has no administrator, treasury, oracle, bridge, token client, or hidden
  execution path.

This registry **does not prove external-chain truth**. A finalized receipt means
only that the record owner authorized the supplied opaque hash. It does not
prove that an EVM transaction succeeded, a CCTP message was attested, an Aave
position exists, a Stellar operation was confirmed, an AI selected a valid
route, or a private preimage satisfies any business rule. Those claims must be
verified independently before the application asks the owner to finalize.

All contract state and events are public. Hashing a privacy budget or manifest
does not create confidentiality by itself. Integrations must use canonical,
domain-separated encodings and enough unpredictable blinding material when a
low-entropy preimage could otherwise be guessed.

The storage horizon is deliberately named `retention_floor_ledger`: Soroban
TTL extension establishes a minimum lifetime, not a deletion date. A newly
created entry may already live longer than the requested floor, archived
persistent entries can be restored, and ledger-level TTL extension is not an
access-controlled operation. Therefore neither the owner nor this contract can
promise that a public commitment or event disappears at the floor. Privacy
Budget and Disclosure Diff must treat the owner, nonce, hashes, status and event
timing as durable public linkage.

## Record lifecycle

```text
absent --commit(owner auth, exact nonce)--> active
active --finalize(owner auth, before receipt close)----------> finalized
active --cancel(owner auth, before execution expiry)---------> cancelled
active --execution expiry------> execution_expired_awaiting_receipt
execution_expired_awaiting_receipt
       --finalize(owner auth, before receipt close)----------> finalized
execution_expired_awaiting_receipt --receipt close-----------> receipt_window_closed
```

`finalized`, `cancelled`, and the derived `receipt_window_closed` condition are
terminal. A nonce is consumed at commit and is never reused, including after
cancellation. The first nonce for each owner is zero. Each successful owner
mutation uses Soroban `require_auth()`, so the authorization covers the exact
contract invocation and arguments.

`RecordStatus::Active` is the stored mutation state; it does not by itself mean
execution remains valid. `effective_status(...)` combines stored status with
the current ledger and is the authoritative lifecycle view. At execution
expiry it changes to `ExecutionExpiredAwaitingReceipt`, and at the receipt-close
boundary it changes to `ReceiptWindowClosed`. Neither transition needs a
transaction, and neither state authorizes execution.

Execution validity, receipt closure, and storage retention are intentionally
separate:

- `execution_expires_at_ledger` is exclusive. `is_active` becomes false and
  cancellation fails at or after this ledger. No new execution may rely on the
  policy after this boundary.
- `receipt_close_by_ledger` is exclusive and must be later than execution
  expiry. Owner-authorized finalization may continue until this boundary so a
  delayed cross-chain result can be acknowledged. Finalization never restores
  execution validity and does not validate the receipt preimage.
- `retention_floor_ledger` controls only the minimum requested record lifetime.
  It must cover the receipt-close deadline. Extending TTL cannot reactivate a
  policy, change either deadline, or change committed hashes, and it cannot
  shorten the entry's existing lifetime.
- Retention is bounded by the network's current maximum entry TTL. If a
  persistent entry has already been archived, callers must use Stellar's normal
  footprint restoration process before invoking this contract again.

## Public interface

| Function | Authorization | Result |
| --- | --- | --- |
| `next_nonce(owner)` | none | Next exact owner nonce, beginning at `0` |
| `get(owner, nonce)` | none | Public record if it is retained |
| `effective_status(owner, nonce)` | none | Ledger-relative lifecycle, including effective expiry and receipt closure |
| `is_active(owner, nonce)` | none | Whether execution validity is currently open |
| `can_finalize(owner, nonce)` | none | Whether owner-authorized receipt closure remains open |
| `commit(...)` | owner | Creates one immutable hash commitment with both deadlines and consumes the nonce |
| `finalize(owner, nonce, receipt_hash)` | owner | Binds one opaque receipt hash before receipt close, including after execution expiry |
| `cancel(owner, nonce)` | owner | Terminates a policy only while execution remains active, without moving funds |
| `extend_ttl(owner, nonce, retention_floor)` | owner | Raises the minimum storage lifetime without changing policy validity |

The emitted events are `policy_committed`, `policy_finalized`,
`policy_cancelled`, and `ttl_extended`, each indexed by owner and nonce.

## Integration requirements

Kletia's browser-side `KLETIA_POLICY_ENVELOPE_V1` is deliberately stable: it
canonicalizes and domain-separates only consent-time fields already known to
the owner, including the environment lane, intended owner and wallet/asset
bindings, scenario and route consent, private amount/recipient commitments,
and privacy-budget preset. The random blind stays on the device. Mutable or
server-assigned fields such as workflow ID, registry nonce and ledger
deadlines, live quotes, step status, transaction hashes, and receipt hashes are
excluded from that blinded preimage. The sealed workflow plan then binds the
opaque commitment to the exact network passphrase, live owner nonce, contract
identity, ledger deadlines, route evidence, and workflow ID. Keeping these two
layers separate prevents a circular commitment while ensuring a refreshed
quote or lifecycle status cannot silently redefine what the owner originally
committed to.

Before finalization, an integrator should build a deterministic receipt from
independently verified evidence and show the resulting disclosure diff to the
user. The application must treat a missing, execution-expired,
receipt-window-closed, cancelled, or unverified record as fail-closed for
execution. The post-expiry finalization path is only an owner-authorized
evidence anchor.

See [`ABI.md`](./ABI.md) for exact types, signatures, errors, events, and
exclusive-boundary behavior.

This package deliberately contains no deployment address. A deployment is
valid only when its network, contract ID, source revision, WASM hash, build
toolchain, and deployment transaction are recorded in the project's signed
deployment manifest.

The current reviewed release artifact SHA-256 is
`723d052be3e3f2585050337607fc3c010f18395825bf434693e863a81d27319d`.
This is a local build identity, not evidence that the contract is deployed.

## Development

The SDK version and Cargo dependency graph are pinned, and the package-local
Rust toolchain file selects Rust `1.91.0`, `clippy`, `rustfmt`, and the
`wasm32v1-none` target.

```bash
cargo fmt --manifest-path contracts/stellar/policy-receipt-registry/Cargo.toml -- --check
cargo test --manifest-path contracts/stellar/policy-receipt-registry/Cargo.toml
cargo clippy --manifest-path contracts/stellar/policy-receipt-registry/Cargo.toml --all-targets -- -D warnings
```

From the repository root, `npm run check:stellar-policy-contract` runs the
format, locked clippy, locked unit-test, and locked release-WASM gates. The root
`npm run verify` pipeline includes this check.

Contract WASM builds and deployments should use the project's pinned Stellar
CLI/toolchain and must not be inferred from a successful host-unit test.

## License

MIT. See SPDX headers in the Rust sources.
