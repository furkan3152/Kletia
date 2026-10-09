# Verifiable intent receipts (`kletia.receipt/v1`)

When an intent ends, Kletia issues a **receipt**: one signed, canonical
document that states what was asked (request digest), what was planned (plan
digest), every step with its quote bindings, and every on-chain reference
with its chain, block or slot, block hash and the evidence that settled it.

- Anyone holding a receipt can check, **offline**, that Kletia signed exactly
  that (SHA-256, Ed25519, RFC 8785 JCS; `verifyReceipt` in `@kletia/core`
  needs no dependency).
- Anyone can re-check the on-chain part **without trusting Kletia**, against
  public RPCs (`npx @kletia/cli receipt reverify`).
- Nothing is public by default. The owner shares chosen parts through links
  whose decryption key only the link carries.
- Kletia cannot quietly show different people different receipts for one
  intent: receipt digests go into an hourly, signed, hash-chained Merkle log
  that anyone can anchor on Base.

A receipt is **not** a proof of best execution, of solvency, or that a
third-party contract is honest (custom contract steps keep "Not audited by
Kletia"), and it is not an invoice.

## What a receipt asserts

*"Kletia, holding key `kid`, on day `issuedOn`, observed the intent
identified by `intent.ref` in status `intent.status`, planned as `planDigest`
from request `requestDigest`, with these steps, and for each listed on-chain
reference observed the listed fields at finalized blocks."*

| Evidence class | Examples | Who you trust | Re-verifiable by |
|---|---|---|---|
| `onchain` | transaction hash, block number and hash, status, sender, target, input digest, logs digest, ERC-20 transfers, Solana slot, blockhash, err, fee, token deltas | Nobody (given an honest RPC majority) | `reverify` |
| `binding` | EVM quote binding of the landed transactions | Nobody | `reverify` (recomputed from landed calldata) |
| `provider` | Relay request id, LI.FI transfer id, deBridge order id | The provider's API | `reverify --providers` |
| `kletia` | request, plan, quotes, planned minimums, outcome checks, custom contract pins, notes | Kletia's signature | Offline signature check |

## Lifecycle

| Intent status | Receipt |
|---|---|
| `completed`, `cancelled` | Issued, `terminal: true` |
| `failed`, `partially_completed` | Issued, `terminal: false`: a failed step may be retried, and a later state gets a new receipt |
| `planned`, `executing`, `settling`, `indeterminate` | Not yet: `409 RECEIPT_NOT_READY` (an earlier receipt of the intent, if any, is returned instead) |
| `expired` | Never (nothing executed): `409 RECEIPT_NOT_APPLICABLE` |
| Dry runs | Never |

**Finality.** A receipt is issued only after every on-chain reference is
finalized: EVM blocks at or below the `finalized` head, with the block hash
re-checked at that height (a different hash is a reorg: nothing is issued,
the intent is refreshed and an alert is logged); Solana signatures with
`confirmationStatus: "finalized"` and the finalized block's blockhash
re-checked. Expect about 15 to 25 minutes after the last leg on Ethereum,
Base, Arbitrum and OP Mainnet, about a minute on Polygon, seconds on Solana
and Arc. While waiting, `GET /v1/intents/{id}/receipt` answers `202` with
`pending: { reason, expectedBy, retryAfterSeconds }` and `Retry-After`.

**Sequences.** A new receipt is issued only when the intent's state (status,
each step's status, references and fill references) changes. Receipt N+1
carries `supersedes = digest(N)`; `GET /v1/intents/{id}/receipts` lists every
sequence with `supersededBy`, and `GET /v1/receipts/{receiptId}/status` tells
holders of a shared receipt whether a newer one exists.

## The document

```jsonc
{
  "receipt": {
    "payload":      { /* signed: skeleton + commitments */ },
    "digest":       "21cf7e34…",          // hex sha256(JCS(payload))
    "signature":    { "alg": "Ed25519", "kid": "DPB4LdUN…", "value": "<base64url 64 bytes>" },
    "disclosures":  { "<group path>": { "salt": "<base64url 16 bytes>", "value": { } } },   // any subset
    "inclusion":    { /* optional, self-verifying: log batch, signature, leaf index, audit path, anchor */ },
    "attestations": { "eas": { /* optional EAS offchain envelope of the digest */ } }
  }
}
```

Only `payload` is signed. The payload holds a public **skeleton** (networks,
step kinds, venues, CAIP-19 tokens without amounts, statuses, failure codes,
the custom contract's integrator and target, day finished, duration, lane)
and salted **commitments** of seven kinds of disclosure groups:

| Group | Holds | Reveals |
|---|---|---|
| `intent.request` | the request (text or actions, accounts, metadata) and its digest | accounts: yes |
| `intent.plan` | the plan record as created and its digest (null for intents created before plan records) | accounts, amounts, venues |
| `intent.timing` | created, first submitted, finished and issued times, finality heads | helps correlation |
| `intent.outcome` | title, consumed inputs, observed outputs, fees, warnings | with timing: yes |
| `steps.<id>.parties` | account, recipient, recipient name | yes |
| `steps.<id>.amounts` | input, expected, minimum and actual outputs, planned amounts, extra costs, fees | often unique on-chain |
| `steps.<id>.evidence` | quote bindings, landed binding, anchors, provider ids, contract pins, failure, notes | **always**: a transaction hash reveals its sender |

Hiding `parties` while showing `evidence` hides nothing: the share profiles
below say so. The raw intent id (a bearer capability) never appears: the
payload carries `intent.ref = hex(SHA-256("kletia.intent-ref.v1:" + intentId))`.

## Algorithms (normative)

**Profile.** `JCS(x)` is RFC 8785 over a restricted profile so every
conforming implementation agrees: only `null`, booleans, strings, arrays,
objects and safe integers (amounts, USD values, blocks and slots above 2^53
are decimal strings); well-formed UTF-16 (no lone surrogates); object keys
from the fixed schema matching `^[A-Za-z0-9_.:-]{1,64}$` (user-keyed maps are
arrays of pairs); no duplicate keys, no `-0`.

```
intentRef     = hex(SHA-256(UTF8("kletia.intent-ref.v1:" + intentId)))
requestDigest = hex(SHA-256(JCS(projectRequest(graph.request))))
planDigest    = hex(SHA-256(JCS(planRecord)))
digest        = hex(SHA-256(JCS(payload)))
commitment    = hex(SHA-256(UTF8("kletia.disclosure.v1:") || JCS({ "path": path, "salt": salt, "value": value })))
salt          = base64url(16 random bytes), fresh per group per receipt
signingInput  = UTF8("kletia.receipt.v1:" + digest)                 // 82 ASCII bytes
signature     = Ed25519.sign(receiptKey, signingInput)               // RFC 8032, base64url
kid           = base64url(SHA-256(JCS({ "crv": "Ed25519", "kty": "OKP", "x": x })))   // RFC 7638
```

The path inside each commitment binds a disclosure to its slot (a step's
evidence cannot be moved to another step); fresh salts keep two receipts of
one user unlinkable through equal values.

**Anchors.** Origin anchors are the step's accepted references in prepared
order; fill anchors are settlement evidence references on the step's
destination network (Relay, LI.FI and deBridge fills). EVM anchors carry the
block number and hash, timestamp, index, status, sender, target, value, input
digest, logs digest and count, and the ERC-20 transfers of the step's
parties; Solana anchors carry the slot, blockhash, block time, version
(legacy, 0 or 1), err, fee payer, fee, programs and the token and lamport
deltas of the step's parties. A refund transaction of a refunded bridge is
not tracked, so it is not anchored in v1.

**Quote binding.** For EVM steps, the evidence's `landedBinding` is
`SHA-256(canonicalJson([{ vm: "evm", chainId, from, to, data, value }, …]))`
recomputed from the landed transactions; it must be one of the step's
prepared bindings (`quotes`). A match proves the user signed exactly what
Kletia prepared. Solana has no landed binding (wallets re-sign and may add
compute-budget instructions); it is checked through the fee payer, programs
and deltas.

## Verification

### Offline (`@kletia/core`)

```ts
import { verifyReceipt } from "@kletia/core";

const keys = (await (await fetch("https://api.kletiaai.xyz/v1/receipts/keys")).json()).keys;
const check = await verifyReceipt(document, { keys, intentId: "int_…", requireGroups: ["steps.*.evidence"] });
// check.valid, check.key.provenance ("pinned" | "supplied" | "none"), check.disclosed, check.sealed,
// check.inclusion, check.intentMatches, check.problems, check.warnings
```

It checks the spec and schema, the profile, the digest, the key (known, not
before `notBefore`, not revoked on `issuedOn`), the Ed25519 signature, every
present disclosure against its commitment (and its internal consistency:
request and plan digests recomputed, anchors on the step's chains), the
required groups, the inclusion proof, and the intent id. It never throws.

**Key trust.** `@kletia/core` pins the production keys
(`KLETIA_RECEIPT_KEY_PINS`, empty until the production key is generated). A
key that is not pinned is accepted only when you supply it
(`provenance: "supplied"`): fetch `GET /v1/receipts/keys` **and** the web
origin's `/.well-known/kletia-receipt-keys.json` and require the same `kid` in
both (two origins served by two services).

### Python (standard library, plus `cryptography` for Ed25519)

```python
import base64, hashlib, json
jcs = lambda o: json.dumps(o, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
h = lambda b: hashlib.sha256(b).hexdigest()
receipt = json.load(open("receipt.json"))["receipt"]
assert h(jcs(receipt["payload"]).encode()) == receipt["digest"]
for path, d in receipt.get("disclosures", {}).items():
    slot = (receipt["payload"]["intent"]["commitments"][path.split(".")[1]] if path.startswith("intent.")
            else next(s for s in receipt["payload"]["steps"] if s["id"] == path.split(".")[1])["commitments"][path.split(".")[2]])
    assert h(("kletia.disclosure.v1:" + jcs({"path": path, "salt": d["salt"], "value": d["value"]})).encode()) == slot
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
pad = lambda s: s + "=" * (-len(s) % 4)
x = "<the key's x from /v1/receipts/keys>"
Ed25519PublicKey.from_public_bytes(base64.urlsafe_b64decode(pad(x))).verify(
    base64.urlsafe_b64decode(pad(receipt["signature"]["value"])), ("kletia.receipt.v1:" + receipt["digest"]).encode())
```

Python's `json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False)`
equals JCS on the receipt profile (ASCII keys, no floats). Deterministic test
vectors (payload, digest, commitments, signature from a published seed,
Merkle root and inclusion, log batch) are in
`packages/core/test/fixtures/receipt-v1-vectors.json`.

### Trustless re-verification

`reverifyReceipt` (`@kletia/sdk/receipts`), the CLI
(`npx @kletia/cli receipt reverify <file or share link>`) and the receipt
page re-read every anchor from public RPCs (a quorum of distinct providers),
compare it field by field, recompute EVM quote bindings and check the log
anchor on Base. Per anchor the result is `match`, `mismatch`, `conflict`,
`unavailable` (public nodes prune history: "not found" is never evidence of
absence) or `not_finalized`.

## Privacy and sharing

Receipts are private: `GET /v1/receipts/{receiptId}` answers `404` until the
owner shares the receipt, and again after the last share is revoked or
expired (unknown and unshared look the same).

```http
POST /v1/intents/int_…/receipt/shares
{ "profile": "proof", "expiresInSeconds": 604800 }
→ 201 { "share": { "id": "rsh_…", "receiptId": "rcpt_…", "sequence": 1, "groups": [ … ], "expiresAt": "…",
                   "url": "https://kletiaai.xyz/r/rcpt_…#s=rsh_…&k=<key>" } }
```

| Profile | Groups disclosed | Use |
|---|---|---|
| `route` (default) | none (skeleton only) | Showing a route |
| `amounts` | `steps.*.amounts`, `intent.outcome` | Proving sizes without addresses |
| `proof` | `amounts` plus `steps.*.evidence`, `intent.timing` | Third-party re-verification (evidence reveals senders through the chain) |
| `full` | everything | Auditor, accountant, counterparty |
| `groups: [...]` | any paths or patterns (`steps.*.evidence`) | Custom |

The selected disclosures are encrypted with AES-256-GCM under a fresh 32-byte
key that only the link carries (in its fragment, which browsers never send
to a server); Kletia keeps the ciphertext
(`base64url(iv || ciphertext || tag)`, AAD
`"kletia.receipt-share.v1:" + receiptId + ":" + shareId`), never the key. The
link is returned once (keyed callers may retry with `Idempotency-Key`; the
stored response is encrypted at rest). Shares default to 30 days
(`expiresInSeconds` 3,600 to 31,536,000, or `null`), at most 10 are active
per receipt, and `DELETE …/receipt/shares/{shareId}` revokes one.

`DELETE /v1/intents/{id}/receipt/disclosures` withdraws every stored
disclosure of the intent's receipts (later ones included) and every share.
The signed payloads (commitments only) and log leaves stay; copies already
downloaded cannot be recalled. Before the first receipt there is nothing to
withdraw: `409 RECEIPT_NOT_READY` (or `RECEIPT_NOT_APPLICABLE`).

| Caller | Can read |
|---|---|
| Holder of the intent id | Every receipt of the intent with its disclosures, its shares; create and revoke shares |
| Holder of a share link | The skeleton and the share's groups |
| Holder of only a receipt id | `404` unless shared; then the skeleton |
| Anyone | Keys, log batches, inclusion by digest |
| Webhook receiver | `intent.receipt_issued` with ids and digest (no disclosures) |
| MCP agent | What its caller could read through the same routes |

## Transparency log

Every hour the log job closes a batch of all receipts not yet in one,
ordered by issuance, at most 65,536 leaves: an RFC 6962 Merkle tree over the
receipt digests and a signed, hash-chained batch document.

```json
{ "spec": "kletia.receipt-log/v1", "seq": 1842, "size": 312, "root": "<hex>", "previous": "<batch digest of seq − 1 or null>", "closedOn": "2026-10-09" }
```

`batchDigest = hex(SHA-256(JCS(batch)))`, signed over
`"kletia.receipt-log.v1:" + batchDigest`. A receipt read after its batch
closed carries `inclusion` (batch, batch signature, leaf index, audit path,
anchor); holders who downloaded earlier ask
`GET /v1/receipts/log/inclusion?digest=…`. Verifiers warn
`INCLUSION_OVERDUE` for a receipt older than 2 days without inclusion, and
two included receipts with the same `intent.ref` and `sequence` but different
digests prove equivocation.

**Anchoring (operator opt-in).** `EAS.timestamp(batchDigest)` on Base
(predeploy `0x4200000000000000000000000000000000000021`, about 51,000 gas).
`apps/api/src/scripts/receipts/anchorLog.ts` prints the calldata of every
unanchored batch (dry run by default) and, only with `--send`, signs with the
operator's gas wallet (`KLETIA_ANCHOR_PRIVATE_KEY`, never loaded by the API),
then reports the transaction (`POST /v1/receipts/log/{seq}/anchor`, operator
key). The API records it only after reading it from Base: a successful call
to the EAS predeploy with calldata `0x4d003070 ‖ batchDigest` whose
`getTimestamp(batchDigest)` equals its block's timestamp. A watcher also
reads `getTimestamp` for recent unanchored batches every 10 minutes, so a
batch anyone anchored is recorded too. Anyone can confirm an anchor with one
`eth_call` to `getTimestamp(bytes32)` (selector `0xd45c4435`).

## EAS envelope (optional)

With `KLETIA_EAS_ATTESTER_KEY` (a secp256k1 key without funds), each receipt
also carries an EAS **offchain** attestation (Version 2) of its digest,
schema `bytes32 receiptDigest,string spec,uint32 sequence`, domain
`EAS Attestation` / `1.0.1` / chain 8453 / the EAS predeploy, recipient the
zero address, `refUID` the superseded receipt's attestation. It verifies
offline with `ecrecover` (no transaction) and in any EAS tooling; it says
nothing beyond the digest. `GET /v1/receipts/keys` lists the attester.

## Keys and rotation

| Variable | Meaning |
|---|---|
| `KLETIA_RECEIPT_SIGNING_KEY` | base64url 32-byte Ed25519 seed (or PKCS#8 PEM). Refused when it equals or derives from `KLETIA_PLATFORM_SECRET` |
| `KLETIA_RECEIPT_KEY_NOT_BEFORE` | First UTC day the key may sign (required in production) |
| `KLETIA_RECEIPT_KEYSET` | Earlier public keys: `[{ "x", "status": "retired" \| "revoked", "notBefore", "revokedOn"? }]` |
| `KLETIA_RECEIPT_NEXT_KEY` | The next public key, published as `status: "next"` |
| `KLETIA_RECEIPTS_ENABLED` | Kill switch (`false`: nothing is issued; reads keep working) |
| `KLETIA_EAS_ATTESTER_KEY` | Optional EAS attester (no funds) |
| `KLETIA_RECEIPT_ISSUER_ORIGIN` | `issuer.origin` of payloads (default `https://api.kletiaai.xyz`) |
| `KLETIA_RECEIPT_LOG_SECONDS` | Log batch interval (default 3,600) |
| `KLETIA_RECEIPT_FINALITY_MAX_SECONDS` | Finality budget before an alert (default 7,200; checks continue hourly) |
| `KLETIA_RECEIPT_CONFIRMATIONS_<NETWORK>` | Confirmation depth where an RPC serves no `finalized` tag |

Without a signing key, a development process signs with an ephemeral key
(`status: "development"`; verifiers warn `KEY_DEVELOPMENT`), and production
keeps queueing (`GET /v1/health` reports `receipts.signer: "missing"`,
pending reads answer `503 RECEIPTS_DISABLED`) until a key is configured.

Rotation: generate key B, publish it as `next` and pin it in the next
`@kletia/core` release; then switch the signing key to B and move A to the
key set as `retired` (it verifies forever). After a compromise on day D, mark
A `revoked` with `revokedOn: D`: receipts A signed on or after D become
invalid, and Kletia re-issues them with B as `sequence + 1`. Batches anchored
before D remain provably older than the compromise. `GET /v1/receipts/keys`
is cacheable for an hour; the web origin's mirror is updated in the same
release.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/v1/intents/{id}/receipt` | intent id | Latest receipt with every disclosure (`?sequence=n`); `202` while pending |
| GET | `/v1/intents/{id}/receipts` | intent id | Every sequence: `{ receiptId, sequence, status, terminal, digest, issuedOn, supersededBy }` |
| POST | `/v1/intents/{id}/receipt/shares` | intent id | Create a share (`profile` or `groups`, `sequence`, `expiresInSeconds`); link returned once |
| GET | `/v1/intents/{id}/receipt/shares` | intent id | Active shares (no keys) |
| DELETE | `/v1/intents/{id}/receipt/shares/{shareId}` | intent id | Revoke (204, idempotent) |
| DELETE | `/v1/intents/{id}/receipt/disclosures` | intent id | Withdraw disclosures and every share (204; 409 before the first receipt) |
| GET | `/v1/receipts/keys` | public | Keys and EAS attesters (cache 1 hour) |
| GET | `/v1/receipts/log` | public | Batches, newest first (`?limit`, `?unanchored=true`) |
| GET | `/v1/receipts/log/inclusion?digest=` | public | Inclusion proof |
| GET | `/v1/receipts/log/{seq}` | public | Batch, signature, anchor; `?leaves=true&offset&limit` (≤ 1,000) |
| POST | `/v1/receipts/log/{seq}/anchor` | operator | Report an anchoring transaction (checked on Base) |
| GET | `/v1/receipts/{receiptId}` | public, while shared | Payload, digest, signature, inclusion, attestations (no disclosures; cache 60 s) |
| GET | `/v1/receipts/{receiptId}/status` | public, while shared | `{ sequence, terminal, supersededBy }` |
| GET | `/v1/receipts/{receiptId}/shares/{shareId}` | public | `{ ciphertext, alg: "A256GCM", groups, expiresAt }` |

Events: `intent.receipt_issued` (`{ intentId, receiptId, sequence, status,
terminal, digest, kid, supersedes }`) on the intent's SSE stream and to the
owner key's webhooks that subscribe to it (webhooks created before it existed
keep their event lists). MCP: `get_receipt` (by intent id or share link) and
the `receipt` line of `get_intent` ([mcp.md](mcp.md)). Health:
`receipts: { signer, store, queue, oldestPendingSeconds, lastBatch }`. Usage:
`receipts: { issued, pending, sharesActive }`.

## Errors

| Code | Status | When |
|---|---|---|
| `RECEIPT_NOT_FOUND` | 404 | Unknown, unshared, or unknown sequence |
| `RECEIPT_NOT_READY` | 409 | The intent is still running (retryable) |
| `RECEIPT_NOT_APPLICABLE` | 409 | The intent expired: nothing executed |
| `RECEIPTS_DISABLED` | 503 | Kill switch or no signing key, on a read of a receipt not issued yet |
| `RECEIPT_SHARE_NOT_FOUND` | 404 | Unknown or revoked share |
| `RECEIPT_SHARE_EXPIRED` | 410 | Expired share |
| `RECEIPT_SHARE_LIMIT` | 409 | 10 active shares |
| `RECEIPT_DISCLOSURES_WITHDRAWN` | 410 | Share creation after a withdrawal |
| `RECEIPT_LOG_NOT_FOUND` | 404 | Unknown batch, or a digest not in a batch yet |
| `RECEIPT_ANCHOR_INVALID` | 422 | The reported transaction does not timestamp the batch |
| `RECEIPT_ANCHOR_EXISTS` | 409 | The batch is already anchored |

Invalid share bodies use `INVALID_REQUEST` with `issues`. Verification
results (`SIGNATURE_INVALID`, `DISCLOSURE_MISMATCH`, …) are `verifyReceipt`
problem codes, not API errors.
