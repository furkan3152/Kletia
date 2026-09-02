# Security policy

Kletia handles transaction preparation, wallet authorization, passkey accounts, external providers, and cross-network recovery. Please report a suspected vulnerability privately before publishing details.

## Supported version

Security fixes target the current `main` branch and the public deployment built from it. Historical tags, grant artifacts, legacy contracts, and superseded deployments may remain for provenance but are not assumed to receive fixes. Deployment manifests identify which contracts are active, legacy, or labs.

## Reporting a vulnerability

Email **security@kletiaai.xyz** with:

- affected component, network, contract or endpoint;
- impact and required attacker capabilities;
- minimal reproduction steps;
- relevant transaction, request, or block identifiers;
- whether funds, credentials, privacy, availability, or integrity are at risk;
- a safe way to contact you.

Do not include private keys, seed phrases, passkey credentials, recovery material, provider secrets, personally identifiable KYC data, or unredacted production database content. Onchain identifiers are public, but explain why each one is relevant.

We aim to acknowledge a complete report within 48 hours and provide an initial triage within seven days. Complex cross-network or upstream issues may require additional validation. Please allow a reasonable remediation and deployment window before disclosure.

## In scope

- Base, Arc, Arbitrum, Arbitrum Sepolia, and Stellar application modules;
- active, migration, and Testnet contracts where Kletia source or configuration creates the issue;
- intent parsing, entity resolution, transaction/XDR preparation, simulation, evidence, and recovery;
- EVM wallets, Stellar passkey C-accounts, Freighter integration, and session binding;
- cross-chain checkpoints, CCTP/Across integration, replay and nonce handling;
- Payment Center provider validation, SEP flows, durable stores, and credential encryption;
- browser privacy/egress controls, API authorization, CORS, rate limiting, and secret handling;
- ZK circuits, Soroban control plane, route auction, private payments, and MPP labs when the vulnerability is reproducible in this repository;
- CI, build, and deployment configuration that can affect a Kletia release.

Testnet and labs status lowers financial exposure; it does not make authentication, privacy, replay, or supply-chain vulnerabilities irrelevant.

## Generally out of scope

- attacks against unrelated third-party infrastructure with no Kletia-specific impact;
- upstream vulnerabilities that are not reachable or meaningfully worsened by Kletia's use;
- social engineering, denial-of-service volume tests, spam, or destructive testing;
- reports that only state a dependency version without a reachable exploit path;
- theoretical economic attacks without executable conditions;
- exposed data that is intentionally public on a blockchain;
- claims that a Testnet faucet balance or documented public deployment address is a secret.

If an upstream dependency is affected through Kletia's configuration, report the Kletia path privately and coordinate upstream disclosure where appropriate.

## Testing rules

- Use your own accounts and the smallest practical Testnet amount.
- Do not access, alter, or move another user's funds or data.
- Do not deploy malicious contracts against public Kletia users.
- Stop immediately if testing creates unexpected custody, privacy, or availability risk.
- A transaction hash is not proof of impact; include the relevant receipt, event, or post-state without exposing secrets.

## Security boundaries

- Kletia is non-custodial: users approve value-moving actions in their wallet or passkey account.
- Model, quote, RPC, relayer, anchor, x402, and paid-response data are untrusted inputs.
- Cross-chain execution is checkpointed and has no global rollback.
- Codehash and deployment identity checks do not constitute a contract audit.
- Test, build, live readiness, and funded execution evidence are separate.
- This repository is not represented as independently audited or formally verified.

## Bug bounty

There is no formal paid bug-bounty program unless Kletia announces one through an official repository or domain. Responsible reports are appreciated, but please do not assume compensation before receiving written confirmation.
