# Kletia Web (@kletia/web)

The Kletia browser application: the product site (home, developer portal, network status), the intent console (`/app`) with Base, Arbitrum, Arc and Solana workspaces, Intent Studio (`/studio`) with wallet execution, and the embeddable widget page (`/embed`). EVM and Solana wallets connect side by side; every transaction is prepared by the API and approved in the user's own wallet.

## Architecture Overview

- **`src/main.tsx`, `src/app/router.tsx`, `src/app/routes/`**: Entry (privacy egress guard first), history router and route table; every page is a lazy chunk and only wallet routes load wallet SDKs.
- **`src/app/pages/`**: Home, Developers, Protocols (venue directory, live from `/v1/protocols`), Networks, Studio, Embed and 404.
- **`src/app/site/`**: Site shell, design primitives and the intent UI (graph view, review, progress, execution flow).
- **`src/app/App.tsx`**: The intent console (EVM chat workspaces and the Solana workspace).
- **`src/networks/`**: Network-owned UI and bindings (`base`, `arc`, `arbitrum`, `solana`).
- **`src/shared/wallet/`**: Chain-agnostic wallet layer (wagmi/RainbowKit for EVM, Wallet Standard for Solana).
- **`src/shared/platform/`**: Platform API v1 client, intent execution hook (`useIntentExecution`), signer binding checks and resumable sessions.
- **`src/shared/sync/`**: Cross-feature event bus and the shared activity store.
- **`src/shared/`**: Chat, layout, validation, state (zustand), privacy and safe storage.

## Motion system

Kletia's motion is mechanical and snappy: cards drop onto the page, press into their shadow and stamp into place. Every animation explains a change of state, and none of it is needed to read or use the page.

- **Tokens**: `--kl-dur-*`, `--kl-ease-*`, `--kl-shift-*`, `--kl-stagger` and the theme-aware `--kl-shadow-ink` in `src/app/styles.css`, mirrored in `src/app/site/motion/tokens.ts`. Tailwind adds `shadow-hard*`, `ease-kl-*`, `duration-90/240/420` and the `kl-*` palette.
- **Primitives** (`src/app/site/motion/`, one file each, no barrel): `Reveal` (scroll reveal), `AnimatedNumber` (count-up), `Marquee` (ticker with a Pause button), `Typewriter`, `FlowLine` (SVG edge with travelling packets), `useSpotlight`, `celebrate`/`useCelebrateOnce`, `runViewTransition`, `RouteEnter`, plus the hooks `useReducedMotion`, `usePageVisible`, `useInView`, `useAutoPause`, `usePrevious` and `useChangeKey`. UI pieces in `src/app/site/ui/`: `Skeleton`, `toast` + `Toaster` (mounted by the router), `Monogram`, and opt-in motion on `Button` (`loading`), `Card` (`spotlight`), `Section` (`reveal`, plus `platform` for its numbered plate), `Stat` (`animateTo`), `StatusDot` (`pulse`), `CodeBlock` (`reveal="lines"`, sliding tabs) and `CopyButton` (`notify`).
- **CSS utilities**: `kl-rise`, `kl-drop`, `kl-node-in`, `kl-stamp`, `kl-shake`, `kl-fill-x`, `kl-draw` (SVG with `pathLength="1"`), `kl-msg-in`, `kl-attn-ring`, `kl-hatch`, `kl-shimmer`, `kl-lift`, `kl-spotlight`, `kl-details` and `kl-scroll-shadow`.
- **Reduced motion**: under `prefers-reduced-motion: reduce` nothing moves. Content shows its final state (or an opacity-only fade of 150 ms or less), loops stop, count-ups show the final value, typing shows the full text and confetti does nothing. Every CSS class has a fallback in the reduced-motion block of `styles.css`, and every JavaScript primitive checks `useReducedMotion()`.
- **Loops**: every infinite animation carries `.kl-loop` (or is in the pause list). It stops in hidden tabs (`html[data-kl-hidden]`, set by the router) and off-screen inside any element that uses `useAutoPause` (`data-kl-paused`). Anything that moves for more than 5 s has a visible pause control.
- **Content first**: text is in the DOM and readable from the first paint. `Reveal` and `CodeBlock reveal="lines"` only hide content that starts below the viewport, focus forces it visible, and printing shows everything. Animated digits and typed text are `aria-hidden` next to an sr-only copy of the final value.
- **Money never animates**: amounts, fees, minimum outputs and anything in a review or signing screen render static and exact.
- **Route transitions**: site-to-site navigations run inside a View Transition (opacity and a small nudge on the page body; the header swaps instantly). Without the API, or with reduced motion, the new page fades in (opacity only, no transform on the page wrapper).
- **Lint note**: destructure hook results (`const { ref, active } = useAutoPause()`); the React Compiler lint rejects `pause.ref` and `spot.style` member access during render.
- **Checks**: `npx tsx scripts/verifyMotionPrimitives.ts` verifies the pure parts (tokens, deterministic jitter and confetti, monogram contrast, the toast queue and the View Transition fallback).

## Art system ("Interchange")

The site is drawn as the printed material of a transit authority for money: networks are lines on a route map, venues are stations, an intent is a ticket and its state is a rubber stamp. The components live in `src/app/site/art/` (one file each, each importing its own stylesheet; `index.ts` exports only types and pure helpers, so never import components from the barrel).

- **Pieces**: `RouteMapCard` (hero map, the phone strip below 600 px of card width), `Ticket`, `TicketStub`, `BlankTicket` (Studio empty state), `Stamp` (the die shape encodes the state), `DepartureBoard` (home and `/networks`), `PlatformSign` (`/protocols`), `SpecSheet` (`/developers`), `EndOfLine` (404), `Icon` (17 pictograms), `LineBullet`, and the ornaments `PlatformNumber` (section eyebrows through `Section`'s `platform` prop), `LineRule`, `HalftoneEdge` and `CropMarks`. `SiteLayout` mounts `PaperDefs` once.
- **Data**: every network name, colour, lane and venue comes from `@kletia/core` (`LINES`, `PRODUCTION_LINES`, `YARD_LINES`, `lineFor`); counts in headings are read from the registry at render time (`src/app/site/registryCopy.ts`).
- **Colour rule**: a network colour appears only where that network is meant. Yellow is signage and Kletia, blue is the primary action, and status greens use the board's lamp green (`#4ADE80`), never a network colour.
- **Night rule**: printed objects (tickets, stamps, signs, the board, the house rules notice) keep their ink at night; only the room around them goes dark.
- **Motion**: the map draws in once, the board riffles when it first scrolls into view, stamps press once. Loops pause off-screen and in hidden tabs, and with reduced motion everything prints finished.
- **Checks**: `node --test src/app/site/art/__tests__/*.test.mjs` (geometry, latency, registry tokens, map layout, contrast, barrel safety).

## Setup Instructions

The web app is part of the root npm workspace. Install once from the repository root:

```bash
npm ci                 # from the repository root; also builds @kletia/core, sdk and widget
npm run dev:web        # from the root, or `npm run dev` here
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
- **`VITE_BACKEND_URL`**: The Kletia API origin serving `/api` and `/v1`.

## Deployment Information

The application is deployed as a static site (Render or Vercel) built from the workspace root with `npm run build:web`. Only `/embed` may be framed by other sites; every other page sends `X-Frame-Options: SAMEORIGIN` and also refuses to render in a cross-origin frame. `npm start` serves the built `dist` with the same headers for self-hosted previews.

## License

MIT
