# Own contract example

Bring your own contract, testnet first. The stand-in is the Aave V3 Pool on
Arbitrum Sepolia (`contract.arbitrum-sepolia.json`, a contract you would
operate yourself); `contract.base.json` is the ERC-4626 vault shape on Base.

```bash
cd examples/own-contract
npm install
export KLETIA_API_KEY=kl_dev_…        # a sandbox key: kletia keys create acme --sandbox
node register.mjs contract.arbitrum-sepolia.json --account 0xYourWallet
CONTRACT_ID=ct_… node session-server.mjs   # http://localhost:3001
```

`register.mjs` runs the four steps and prints what users will see:

1. **inspect** (`contracts.inspect`): pins (code hash, proxy and
   implementation), verification, and for an ERC-4626 vault its asset
   (`hints.erc4626`, which `kletia contracts init` uses to prefill the deposit
   entry).
2. **validate** (`validateContractDefinition` from `@kletia/core`): the same
   checks the API runs, before anything is stored.
3. **register** (`contracts.register`, idempotent). Testnet registrations are
   active at once; on mainnet they are pending until `activatesAt`.
4. **test** (`contracts.test`): plan, prepare and simulate the first entry
   for your own account, then the review: decoded call, exact approval,
   simulated asset changes and "Not audited by Kletia". Nothing is signed.

`session-server.mjs` creates **one session per page view**: a single-use,
15-minute session for the registration, allowed only on the page's origin,
with the visitor's amount bounded to 1-100 USDC. `page.html` embeds it with
`<kletia-intent session="…">`; the visitor's wallet signs, the key stays on
the server. A session for a registration that is still pending carries a
`CONTRACT_PENDING` warning (logged by the server).

**No server of your own (phase 2):** store the registration as a project
flow and run it in the browser with a publishable key.

```bash
KLETIA_API_KEY=kl_dev_… CONTRACT_ID=ct_… PAGE_ORIGIN=https://shop.example node flow.mjs
```

`flow.mjs` reads the project (`projects.get`), merge-patches it under
`If-Match` with your page origin in `allowedOrigins` and a `supply` flow (the
registration's entry, 1-100 USDC chosen by the visitor), issues a publishable
key (`kl_pub_…`, shown once) and prints the snippet:

```html
<kletia-intent key="kl_pub_…" flow="supply"></kletia-intent>
```

The flow is saved by your key, so its call step uses your registration; the
publishable key alone can never call a contract (`CONTRACT_UNKNOWN`), works
only from the allowed origins, and each visitor gets a single-use 600 s
session from the flow. See docs/platform/projects.md.

The supply mints aTokens, whose balance grows by interest between blocks, so
the entry's output is declared `"rebasing": true`: Kletia then accepts a
Transfer-log amount that differs from the balance change by at most 2 base
units and uses the balance change as the observed output. Leave the flag out
for ordinary tokens.

From the command line instead:

```bash
kletia contracts inspect --network arbitrum-sepolia --address 0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff
kletia contracts register --file contract.arbitrum-sepolia.json
kletia contracts test ct_… --entry supply --account arbitrum-sepolia:0xYourWallet --amount 1
```

`npm run check` runs `smoke.mjs` against an in-process stub of `/v1` (no
network, no key, nothing signed; it covers register.mjs, session-server.mjs
and flow.mjs); `npm run check:examples` at the repository
root runs it through this example's `build` script.
