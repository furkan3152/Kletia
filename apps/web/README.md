# Kletia Web (@kletia/web)

The official Kletia browser application. A unified React SPA that serves a multi-chain dashboard, natural-language intent chat, token launching, portfolio management and an x402 console. It covers production profiles on Base and Arbitrum, the Arc Testnet workspace, and the staged Base to Arbitrum cross-chain workflow. Every transaction is compiled deterministically and approved in the user's own wallet.

## Architecture Overview

- **`src/app/`**: Application composition root and global Tailwind theme stylesheets.
- **`src/networks/`**: Network-specific UI, policies, runtime bindings, and wallet-facing evidence (segmented into `base`, `arc`, and `arbitrum`).
- **`src/shared/`**: Reusable components, chat logic, layout, validation, state management (zustand), hooks, and types.
- **`src/cross-chain/`**: Staged cross-chain workflow timeline and progress visualizer.
- **`src/integrations/`**: Integrations with external services, such as Allora and Webacy.

## Setup Instructions

```bash
npm ci --legacy-peer-deps
```

## Available Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start the Vite development server. |
| `npm run build` | Compile TypeScript, build the production bundle and enforce the entry bundle budget. |
| `npm run typecheck` | Type-check the application without emitting output. |
| `npm run lint` | Run ESLint checks across the codebase. |
| `npm run verify:intent-user-journey` | Verify the browser intent boundaries for staged workflows and history redaction. |
| `npm run preview` | Serve the production `dist` directory locally for preview. |

## Key Environment Variables

Refer to [`.env.example`](.env.example) for all configurable values.
- **`VITE_*`**: Browser-facing variables are public. These must **never** contain private keys or API secrets.
- **`VITE_ARBITRUM_MVP_ENABLED`**: When set to `true` (and matched by API attestation), unlocks Arbitrum routes.

## Deployment Information

The application is deployed as a Static Site via Render. Production runs simply by serving the `dist` folder; `npm start` is only retained for local or self-hosted Node preview configurations of the static bundle.

## License

MIT
