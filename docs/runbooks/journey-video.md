# Journey video runbook

`tooling/journey-video/run.mjs` records a full, unskipped session of a normal
user on the Kletia desk as an H.264 video, and checks every step as a test. It
runs the real API and the real web app against local forks of the real
networks, with a throwaway wallet that exists only in the harness's memory.

## Run it

```bash
npm run build:packages                       # once per checkout
node tooling/journey-video/run.mjs --out /path/to/output
```

| Flag | Effect |
|---|---|
| `--out DIR` | Output folder (default `$JOURNEY_OUT_DIR` or `<tmp>/kletia-journey-video`). |
| `--phone` | Records the 390x844 phone cut instead of 1280x800. |
| `--skip-solana` | No surfpool fork, no Solana wallet, no Solana chapter. |
| `--api-url URL` | Read-only run against a deployed API: no forks, the wallet connects but refuses every signature, the journey stops at the plan screens. |
| `--no-build` | Reuses `apps/api/dist` and the web build already in `--out`. |
| `--keep-running` | Leaves the forks and the API up after the recording (Ctrl+C stops them). |
| `--tools-dir DIR` | Where `anvil` and `surfpool` are kept (default `<out>/bin`). |

Output in `--out`: `journey-desktop.mp4` (chapters embedded),
`journey-desktop.chapters.txt`, `journey-desktop.preview.gif` (10x, 2-4 MB),
`journey-desktop.assertions.json`, `FINDINGS.md` with a screenshot per finding
under `findings-desktop/screens/`, and `logs/` (forks, API, builds). The exit
code is 0 only when every check passed.

Needs: Node 22, ffmpeg, a preinstalled Chromium (`JOURNEY_CHROMIUM`, default
`/opt/pw-browsers/chromium`), Playwright from the workspace or the global npm
root, about 1 GB of free disk (tools 140 MB, two
builds, the raw video until it is encoded).

## What it starts

1. **Forks.** `anvil` (Foundry v1.5.1, official GitHub release, sha256 pinned)
   forks Base (8545), Arbitrum One (8546) and Polygon (8547) with interval
   mining and no 1 gwei tip floor; `surfpool` (Solana Foundation v1.6.1, pinned
   the same way) forks Solana mainnet-beta (8899). The fork sources are keyless
   endpoints that serve recent historical state; `JOURNEY_<NETWORK>_FORK_URL`
   or the usual `BASE_RPC_URL` style variables override them.
2. **Wallet.** A fresh EVM key (viem) and ed25519 key (node:crypto) are made in
   memory, never written or logged, and funded on the forks only:
   `anvil_setBalance`, token balance slots found by probing `anvil_setStorageAt`
   (USDC on Base and Arbitrum, USDC and USDC.e on Polygon), and surfpool's
   `surfnet_setAccount` / `surfnet_setTokenAccount` (SOL, USDC). The harness
   refuses to start when a signing RPC is not on 127.0.0.1.
3. **API.** `apps/api` built and started on port 3001 with every chain RPC and
   simulation RPC on the forks, memory stores, random per-run secrets and the
   real public provider APIs for quotes. `lib/netguard.mjs` is preloaded: any
   outbound request that is not a read (GET, a JSON-RPC read, a quote or
   unsigned-build call) is refused and logged, so order books, relayers and
   public nodes never receive anything the run signed.
4. **Warm-up.** The journey's sentences are dry-run once through the API so the
   forks fetch the contract state they need before the camera rolls (a cold
   fork read can exceed the API's 10 s RPC timeout).
5. **Web.** `apps/web` built with `VITE_ALLOW_LOCAL_BACKEND=true` and the
   `VITE_*_RPC_URL` variables on the forks into `--out`, served on port 5180.
6. **Browser.** Chromium with an init script that announces "Kletia Test
   Wallet" over EIP-6963 and registers it with Wallet Standard (Solana), draws
   the cursor, the captions and the wallet popup. Every request needing consent
   opens the popup; the script clicks Approve or Reject with the cursor. A
   route guard applies the same write rules to the page itself.

## The journey

Home, the desk, connect EVM and Solana, holdings, sign in and turn tracking
on, a Uniswap swap on Base (signed and settled), an Aave deposit, a Solana USDC
transfer, a sentence with a question, a bridge up to the deposit prompt, a GMX
order on Arbitrum, a CoW limit order, Polymarket, a weekly DCA automation, the
dashboard, history and activity, two assistant questions, the signed receipts
(Solana at once; Base only after about 16 minutes of finality), a glimpse of
the developers portal and back, disconnect. Each step asserts what a user
should see; `--phone` runs the same journey at 390x844.

## Chapter times

Under load the screencast starts late and drifts from the script's clock, so
the video carries its own marks: a full-screen title card in `#FF6A3D` at the
start and the end, and a 16 px corner flash of that colour at each chapter.
`lib/sync.mjs` finds them in the recording and puts every chapter on its
flash (linear between the two cards when the count does not match).

## What a fork cannot show (said in the captions)

- Relayers, solvers and keepers watch the live chains: an Across deposit, a
  GMX order or a CoW order made on a fork is never filled, so the bridge is
  rejected at the deposit prompt and the CoW order stops at its signature.
- Aggregator routes can include market-maker quotes signed for the live chain;
  they revert on a fork, so the swap sentence names Uniswap.
- Jupiter simulates swaps on the real Solana chain, where the throwaway wallet
  is empty, so Solana shows a token transfer instead of a swap.
- Polymarket's location check applies to the machine running the harness.
- Explorer links point at the real chains; the fork transactions are not there.
- History needs a provider key (`ETHERSCAN_API_KEY`, `ALCHEMY_API_KEY`,
  `HELIUS_API_KEY`), and those providers read the real chains, not the forks.
