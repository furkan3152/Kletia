# Kletia Contracts — Arc Testnet

Arc-only Solidity workspace for the contracts already deployed on Arc Testnet.
It includes native-USDC swap, vault, staking, lending, memo, batch-payment,
agent-registry, OTC, and trusted-forwarder contracts.

```bash
npm ci --legacy-peer-deps
npm run compile
npm test
```

Deployment credentials are optional and local-only. Use `ARC_PRIVATE_KEY` and
`ARCSCAN_API_KEY` only in this package's ignored `.env`; never expose them to
the web application or API runtime.
