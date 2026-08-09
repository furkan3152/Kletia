# Kletia Technical Architecture — One Pager

## Product model

Kletia is an intent-driven aggregator with one canonical application shell and
two deliberately isolated execution profiles:

| Profile | Network | Settlement asset | Purpose |
| --- | --- | --- | --- |
| `base` | Base Mainnet (`8453`) | ETH for gas; Base assets such as native USDC | Production DeFi aggregation, x402 discovery/payment flows and Base-native experiences |
| `arc` | Arc Testnet (`5042002`) | Native USDC | Arc-native programmable-money flows, App Kit integrations and testnet experimentation |

Changing the profile is not a cosmetic RPC toggle. The wallet chain, intent
parser context, supported actions, contract registry, native asset metadata,
widgets, conversation state and response validation all change together. A
Base response cannot be executed while Arc is active, and vice versa.

The canonical runtime is:

- frontend: `frontend/base_mainnet`
- backend: `backend/base_mainnet`
- deployment definition: `render.yaml`

The older `arc_testnet` application directories are retained only as reference
copies. Arc remains a first-class profile inside the canonical runtime.

## Intent lifecycle

```text
Natural-language request or widget seed
             |
             v
Deterministic grammar + bounded AI parsing
             |
             v
Network/action policy and canonical registry
             |
             v
Live read-only discovery and route construction
             |
             v
Efficiency ranking + security/simulation evidence
             |
             v
Network-bound response envelope
             |
             v
Explicit wallet approval and user-confirmed execution
```

User-facing aggregator widgets do not bypass the intent engine. They create
structured, editable text seeds for the same parser and routing pipeline used
by the main prompt. The Base x402 seller console is a deliberately separate,
advanced gateway-owner surface: factory deployment, price updates and
withdrawals are direct wallet writes because they administer the user's own
gateway rather than route an aggregator intent. Those writes still require
Base chain binding, reviewed-factory provenance, live price/owner checks,
action-bound Webacy approval, exact simulation and a successful receipt.

## Base Mainnet aggregation

Base routes are built from a canonical protocol registry and live, block-bound
reads. The current engine covers:

- swaps across Aerodrome and V2/V3 quote sources, with additional officially
  sourced candidates kept discovery-only until their calldata and spender
  semantics have dedicated validators;
- Aave V3, Moonwell and Compound lending markets;
- ERC-4626 vault comparisons and direct deposits;
- direct staking targets;
- reserve-bearing liquidity-pool discovery from canonical factories;
- Across bridge quotes;
- x402 service discovery and payment-aware intents.

The engine does not treat an official contract address as sufficient execution
authorization. A route becomes executable only when its operation-specific
target, selector, token flow, payer/receiver, amount, slippage/deadline and
simulation rules are supported.

Efficiency is action-specific. Swaps can be compared by expected output, price
impact, gas and simulation evidence. Supply and borrow markets can be compared
using live rate and availability data. Liquidity-removal positions are not
pretended to be economically comparable without a trustworthy valuation
oracle.

## Arc Testnet profile

Arc has its own action set, contract manifest, target allowlist, ABIs, native
asset rules and response envelope. Arc routes may use the existing deployed Arc
contracts and official Arc App Kit/integration surfaces; Base protocol targets
are never inherited into the Arc profile.

The Arc profile remains testnet-only. Testnet balances, quotes and execution
results must not be presented as Base Mainnet value or production guarantees.
The existing deployed Arc contracts are not modified by the unified
application architecture.

## Execution and custody boundaries

Kletia intentionally does **not** force every action through one generic
router:

- swaps compatible with the existing Fee Router may use the wrapper only when
  caller, spender and output-recipient semantics remain safe;
- lending, ERC-4626 vault, staking and classic liquidity actions execute
  directly from the user's wallet when an intermediary would otherwise become
  the protocol-recognized owner;
- Permit2-based or dynamically targeted aggregators remain non-executable until
  a purpose-built adapter and validator exists;
- every approval is explicit and scoped to the route's declared spender.

No transaction is considered successful from a hash alone. The client waits
for a successful receipt, and approval-dependent actions receive a final
`eth_call` after the approval is confirmed. Protocols with return-code failure
semantics, such as Moonwell, also require the expected success return value.

## Evidence and failure model

Route responses carry their network, chain ID, request ID, target and discovery
evidence. Live market and pool reads are pinned to an observed block where the
provider supports it. Provider errors are not converted into zero balances,
invented pools, mock rates, APY or impermanent-loss projections.

Security and simulation are shared system capabilities, but they consume the
active profile's policy and targets. If target validation, bytecode checks,
market availability or simulation cannot produce the required evidence, the
affected route fails closed or is explicitly marked unavailable.

## Extension rule

New protocols enter Kletia in stages:

1. add an official-source registry entry;
2. verify chain ID and runtime bytecode;
3. implement protocol-specific discovery and normalized route evidence;
4. bind parser intents and widget seeds to the same action;
5. add calldata, spender, recipient and state-transition validators;
6. test unavailable, paused, capped and reverting paths;
7. only then consider execution allowlisting or a new adapter.

This staged model preserves aggregator breadth without turning address quantity
into unsafe execution breadth.
