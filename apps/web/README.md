# Kletia Web (@kletia/web)

The Kletia browser application: the product site (home, developer portal, network status), the intent console (`/app`) with Base, Arbitrum, Arc and Solana workspaces, Intent Studio (`/studio`) with wallet execution, and the embeddable widget page (`/embed`). EVM and Solana wallets connect side by side; every transaction is prepared by the API and approved in the user's own wallet.

## Layout

- `src/main.tsx`, `src/app/router.tsx`, `src/app/routes/`: Entry (privacy egress guard first), history router and route table; every page is a lazy chunk and only wallet routes load wallet SDKs.
- **`src/app/pages/`**: Home, Developers, Networks, Studio, Embed and 404.
- `src/app/site/`: Site shell, design primitives and the intent UI (graph view, review, progress, execution flow).
- **`src/app/App.tsx`**: The intent console (EVM chat workspaces and the Solana workspace).
- `src/networks/`: Network-owned UI and bindings (`base`, `arc`, `arbitrum`, `solana`).
- `src/shared/wallet/`: Chain-agnostic wallet layer (wagmi/RainbowKit for EVM, Wallet Standard for Solana).
- `src/shared/platform/`: Platform API v1 client, intent execution hook (`useIntentExecution`), signer binding checks and resumable sessions.
- `src/shared/sync/`: Cross-feature event bus and the shared activity store.
- **`src/shared/`**: Chat, layout, validation, state (zustand), privacy and safe storage.

## Setup

The web app is part of the root npm workspace. Install once from the repository root:

```bash
npm ci                 # from the repository root; also builds @kletia/core, sdk and widget
npm run dev:web        # from the root, or `npm run dev` here
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start the Vite development server. |
| `npm run build` | Compile TypeScript, build the production bundle and enforce the entry bundle budget. |
| `npm run typecheck` | Type-check without emitting output. |
| `npm run lint` | Run ESLint. |
| `npm run verify:intent-user-journey` | Verify the browser intent boundaries for staged workflows and history redaction. |
| `npm run preview` | Serve the production `dist` locally. |

## Environment

[`.env.example`](.env.example) lists every value.

## Deployment

The application is deployed as a static site (Render or Vercel) built from the workspace root with `npm run build:web`. Only `/embed` may be framed by other sites; every other page sends `X-Frame-Options: SAMEORIGIN` and also refuses to render in a cross-origin frame. `npm start` serves the built `dist` with the same headers for self-hosted previews.

## License

MIT
