# The network: Kletia's ecosystem

Kletia is the **Interchange**: its intent engine is the central station. The products built from that engine are **lines** that leave it. The site shows the family at [kletiaai.xyz/network](https://kletiaai.xyz/network), with a page per line, and a section on the landing page.

| Line | Product | What it does | Networks | Status |
|---|---|---|---|---|
| The Interchange | **Kletia** | Intent infrastructure for EVM and Solana: one sentence becomes planned, quoted transactions your own wallet signs. | Ethereum, Base, Arbitrum One, OP Mainnet, Polygon PoS, Solana (plus test networks) | Live: [kletiaai.xyz](https://kletiaai.xyz), [api.kletiaai.xyz](https://api.kletiaai.xyz) |
| Summit Line | **Elyia** | The intent, trading and portfolio deck for Elysium, HyperEVM and HyperCore. Guide: Ely the goat. | HyperCore (Floor), HyperEVM (Ridge), Elysium (Summit) | Testnet first, in development. No public repository or API host yet. |
| Coast Line | **Lykia** | Policy-bound agents and stablecoin routing on Arc Network. Guide: Lyko, an Anatolian shepherd dog. | Arc mainnet | Live on Arc mainnet: [app](https://lykia-akdogan1.vercel.app), [API](https://lykia-api-akdogan1.vercel.app), [repository](https://github.com/furkan3152/Lykia) |

## Lineage

Stated as it happened:

1. **Kletia's intent engine** came first: the intent graph, the planner, the Rule Book and the developer platform.
2. **Elyia ported Kletia's engine concepts** (the intent graph and its lifecycle, the Rule Book, a developer platform) to Elysium, HyperEVM and HyperCore.
3. **Lykia built on that lineage for Arc**, with its own policy layer (the Fence), ERC-8004 Tags for agents and a family of sub-products, the League.

The line map on `/network` draws exactly this: one trunk from the Interchange into the Engine port (Elyia's first station), the Summit Line climbing from there, and the Coast Line leaving the same port for Arc.

## Transfer stations

One concept, three names. These rows live in `apps/web/src/app/pages/network/networkData.ts` (`TRANSFERS`), so the site and this page say the same thing.

| Concept | Kletia | Elyia | Lykia |
|---|---|---|---|
| Say it in one sentence | Intent graph | Ask Ely | Ask Lyko |
| Rules before signing | Rule Book | Rule Book | The Fence |
| Build on it | Developer portal | Developers | API, SDKs, the League |
| Who signs | Your wallet | Your wallet | Your wallet or a Tagged agent (ERC-8004) |

All three are non-custodial: the server never signs.

## Lykia mainnet contracts (Arc)

| Contract | Address |
|---|---|
| LykiaAccountFactory | `0x810e8db89f4c4e8fa814ed3ed0d636d3416dd7f9` |
| LykiaRouter | `0xc9c0ea4d22ddbef4504a634759fb78334efc5d18` |
| LykiaOrders | `0xdcefebb3d449b7f8965c5f1ae3bba836f30ae6cc` |

## Live data on the board

The departure board shows Kletia's own `GET /v1/health` (networks answering) and Lykia's live reading. Elyia has no public API, so its row is a fixed "testnet, building" entry.

Lykia's public API answers `GET /v1/stats` with `Access-Control-Allow-Origin: *`, but `GET /v1/health` sends **no CORS header** (checked 2026-11-04), so a browser on kletiaai.xyz cannot read it. Kletia's API therefore relays both:

```
GET https://api.kletiaai.xyz/api/network/lykia
```

- Source: `apps/api/src/http/routes/network.ts`, tests in `apps/api/src/http/__tests__/networkRelay.test.ts`.
- Takes no input; the upstream origin (`https://lykia-api-akdogan1.vercel.app`) is fixed in code, so the route cannot be pointed anywhere else.
- Reads `/v1/stats` and `/v1/health` in parallel with a 4 second timeout, keeps only the fields the board prints (status, version, the Arc mainnet head and latency, protocol counts, accounts created, contract names and addresses), and caches the answer for 60 seconds (a full failure for 15 seconds). Concurrent callers share one upstream request.
- Answers `200` with `{ success, source, stats, health, fetchedAt }` and `Cache-Control: public, max-age=60`, or `502` with `no-store` when neither upstream call worked. It sits behind the `/api/` rate limiter and the first-party CORS allowlist like every other `/api` route.

In the browser (`apps/web/src/app/pages/network/lykiaLive.ts`) the page asks the relay first; if the relay cannot be reached it reads `/v1/stats` directly and shows no Arc reading rather than a guess. Answers are cached in memory and `sessionStorage` for a minute and shared by the landing section, `/network` and the line page. Every missing value prints as "—".

## Design

Each line keeps its own design language inside Kletia's frame:

- Kletia's **Card machine** (warm-grey machine, keycaps, LEDs, the split-flap board) and its transit system (board, line map, tickets) frame the page.
- Elyia's ticket is printed in **Pixel Survey**: Pixelify Sans, Silkscreen and IBM Plex Mono, a 4 px grid with stepped corners, the altitude layers (Floor `#1E6B7D`, Ridge `#8A5A2B`, Summit `#17788C`), contour ink and Ely climbing the trail.
- Lykia's ticket is printed in **Mosaic**: tesserae with grout and tone jitter in navy, terra, ochre, sea, olive and cream, a Lycian coast with a rock tomb, and Lyko trotting the shore.

All art is code (canvas, `apps/web/src/app/pages/network/pixelArt.ts`); there are no image files. The pixel fonts load only on the network routes (`networkFonts.ts`). Kletia's printer feeds each ticket out of its slot and stamps it; the line map's train lights run Interchange → Summit Line, then Interchange → Coast Line. Animations pause off screen and in hidden tabs, and reduced motion (the system setting or the site's own switch) shows the finished, stamped tickets and no train lights. Sounds use Kletia's existing sound system and its mute rules (off until switched on).

## Updating

- When Elyia's repository becomes public, set `ELYIA_PUBLIC` to `true` and add its links in `networkData.ts`.
- A new line: add it to `LINES`, `DEPARTURES`, `MAP_STOPS`, `TRANSFERS` and `LINE_DETAILS`, then add a route next to `network`, `networkElyia` and `networkLykia` in `routeTable.ts` and to `public/sitemap.xml`.
