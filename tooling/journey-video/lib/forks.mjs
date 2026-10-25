// Local forks for the journey: anvil (Foundry) for Base, Arbitrum and Polygon,
// surfpool (Solana Foundation) for Solana. Binaries come from the projects'
// official GitHub releases, pinned by version and sha256, and only the one
// executable is unpacked. Public RPCs are read to build the forks; every write
// (funding cheats, the wallet's transactions) goes to the forks on 127.0.0.1.
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { encodeAbiParameters, encodeFunctionData, keccak256, pad, parseAbi, toHex } from "viem";

const RELEASES = {
  anvil: {
    url: "https://github.com/foundry-rs/foundry/releases/download/v1.5.1/foundry_v1.5.1_linux_amd64.tar.gz",
    sha256: "73640b01bd9ed29fdb4965085099371f8cf0dbbec3e2086cf54564efc4dcfe88",
    member: "anvil",
  },
  surfpool: {
    url: "https://github.com/solana-foundation/surfpool/releases/download/v1.6.1/surfpool-linux-x64.tar.gz",
    sha256: "64cff3fd6bb00bb0d5c7edef2915a491338d14eb19b7130abf9c81ee5357d165",
    member: "surfpool",
  },
};

/**
 * The fork set: chain id, port and the public RPCs it may be forked from (env override first).
 * A fork reads state at its fork block, which the head of a public RPC soon
 * calls "archive": these keyless endpoints served recent historical state
 * (checked 2026-10-24; publicnode refuses it without a token).
 */
export const EVM_FORKS = [
  { key: "base", chainId: 8453, port: 8545, blockTime: 2, env: "JOURNEY_BASE_FORK_URL", fallbackEnv: "BASE_RPC_URL", publicRpcs: ["https://mainnet.base.org", "https://base.gateway.tenderly.co"] },
  { key: "arbitrum", chainId: 42161, port: 8546, blockTime: 1, env: "JOURNEY_ARBITRUM_FORK_URL", fallbackEnv: "ARBITRUM_RPC_URL", publicRpcs: ["https://arb1.arbitrum.io/rpc", "https://arbitrum.gateway.tenderly.co"] },
  { key: "polygon", chainId: 137, port: 8547, blockTime: 2, env: "JOURNEY_POLYGON_FORK_URL", fallbackEnv: "POLYGON_RPC_URL", publicRpcs: ["https://polygon.gateway.tenderly.co", "https://polygon.drpc.org"] },
];
// The official endpoint answers getTokenAccountsByOwner, which surfpool forwards for the wallet's balances.
export const SOLANA_FORK = { port: 8899, wsPort: 8900, env: "JOURNEY_SOLANA_FORK_URL", fallbackEnv: "SOLANA_RPC_URL", publicRpcs: ["https://api.mainnet-beta.solana.com"] };

/** Tokens the throwaway wallet gets on the forks (official addresses, see packages/core/src/protocols.ts). */
export const FUNDING = {
  8453: { native: 2n * 10n ** 18n, tokens: [{ symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: 2_500n * 10n ** 6n }] },
  42161: { native: 1n * 10n ** 18n, tokens: [{ symbol: "USDC", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", amount: 1_000n * 10n ** 6n }] },
  137: {
    native: 50n * 10n ** 18n,
    tokens: [
      // Polymarket collateral (USDC.e) and native USDC.
      { symbol: "USDC.e", address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", amount: 250n * 10n ** 6n },
      { symbol: "USDC", address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", amount: 250n * 10n ** 6n },
    ],
  },
};
export const SOLANA_FUNDING = { lamports: 5_000_000_000, usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", usdcAmount: 500_000_000 };

async function download(tool, toolsDir) {
  const release = RELEASES[tool];
  const target = join(toolsDir, tool);
  if (existsSync(target)) return target;
  mkdirSync(toolsDir, { recursive: true });
  const archive = join(toolsDir, `${tool}.download.tgz`);
  process.stdout.write(`downloading ${tool} from ${release.url}\n`);
  const response = await fetch(release.url);
  if (!response.ok || !response.body) throw new Error(`${tool} download failed: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
  const digest = createHash("sha256").update(await readFile(archive)).digest("hex");
  if (digest !== release.sha256) {
    rmSync(archive, { force: true });
    throw new Error(`${tool} archive sha256 ${digest} does not match the pinned ${release.sha256}.`);
  }
  execFileSync("tar", ["-xzf", archive, "-C", toolsDir, release.member]);
  rmSync(archive, { force: true });
  return target;
}

async function rpc(url, method, params = []) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

async function waitFor(url, method) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      return await rpc(url, method);
    } catch (error) {
      if (Date.now() > deadline) throw new Error(`${url} did not come up: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

function sourceRpcs(spec) {
  const configured = process.env[spec.env]?.trim() || process.env[spec.fallbackEnv]?.trim();
  return configured ? [configured] : spec.publicRpcs;
}

/** Throws unless `url` serves state at a block about ten minutes old (what a fork needs). */
async function probeHistoricalState(url) {
  const head = BigInt(await rpc(url, "eth_blockNumber"));
  await rpc(url, "eth_getBalance", ["0x0000000000000000000000000000000000000000", toHex(head - 300n)]);
}

/** Starts the three anvil forks; resolves to { [chainId]: localUrl } and the child processes. */
export async function startEvmForks({ toolsDir, logs }) {
  const anvil = await download("anvil", toolsDir);
  const children = [];
  const urls = {};
  const sources = {};
  for (const spec of EVM_FORKS) {
    let source = null;
    for (const candidate of sourceRpcs(spec)) {
      try {
        await probeHistoricalState(candidate);
        source = candidate;
        break;
      } catch (error) {
        process.stdout.write(`  ${spec.key}: ${candidate} cannot back a fork (${error.message.slice(0, 120)})\n`);
      }
    }
    if (!source) throw new Error(`No RPC can back the ${spec.key} fork; set ${spec.env}.`);
    sources[spec.key] = source;
    const log = logs(`anvil-${spec.key}.log`);
    // --disable-min-priority-fee: otherwise anvil asks 1 gwei tips and every fee on the fork looks 100x too high.
    // --block-time: blocks keep coming, so confirmations and the "finalized" head advance as on the real chain.
    const child = spawn(
      anvil,
      ["--fork-url", source, "--port", String(spec.port), "--host", "127.0.0.1", "--chain-id", String(spec.chainId), "--no-storage-caching", "--accounts", "1", "--silent", "--disable-min-priority-fee", "--block-time", String(spec.blockTime)],
      { stdio: ["ignore", log, log] },
    );
    children.push(child);
    urls[spec.chainId] = `http://127.0.0.1:${spec.port}`;
  }
  for (const spec of EVM_FORKS) {
    const chainId = Number(await waitFor(urls[spec.chainId], "eth_chainId"));
    if (chainId !== spec.chainId) throw new Error(`The ${spec.key} fork answers chain ${chainId}.`);
  }
  return { urls, children, sources };
}

/** Starts surfpool forked from Solana mainnet-beta; null when it cannot start. */
export async function startSolanaFork({ toolsDir, logs, workDir }) {
  const surfpool = await download("surfpool", toolsDir);
  mkdirSync(workDir, { recursive: true });
  const source = sourceRpcs(SOLANA_FORK)[0];
  const log = logs("surfpool.log");
  const child = spawn(
    surfpool,
    ["start", "--rpc-url", source, "--port", String(SOLANA_FORK.port), "--ws-port", String(SOLANA_FORK.wsPort), "--host", "127.0.0.1", "--no-tui", "--no-studio", "--no-deploy", "--yes", "--ci"],
    { cwd: workDir, stdio: ["ignore", log, log] },
  );
  const url = `http://127.0.0.1:${SOLANA_FORK.port}`;
  await waitFor(url, "getSlot");
  return { url, children: [child], source };
}

const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

/** Finds the balances mapping slot by writing a probe value and reading balanceOf back (fork only). */
async function setTokenBalance(url, token, holder, amount) {
  for (const layout of ["solidity", "vyper"]) {
    for (let slot = 0n; slot < 64n; slot += 1n) {
      const key =
        layout === "solidity"
          ? keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [holder, slot]))
          : keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "address" }], [slot, holder]));
      const before = await rpc(url, "eth_getStorageAt", [token, key, "latest"]);
      await rpc(url, "anvil_setStorageAt", [token, key, pad(toHex(amount), { size: 32 })]);
      const data = encodeFunctionData({ abi: ERC20, functionName: "balanceOf", args: [holder] });
      const balance = BigInt(await rpc(url, "eth_call", [{ to: token, data }, "latest"]));
      if (balance === amount) return;
      await rpc(url, "anvil_setStorageAt", [token, key, before]);
    }
  }
  throw new Error(`Could not find the balance slot of ${token}.`);
}

/** Native gas and token balances for the throwaway address on every EVM fork. */
export async function fundEvm(urls, address) {
  const funded = [];
  for (const [chainId, url] of Object.entries(urls)) {
    const plan = FUNDING[chainId];
    if (!plan) continue;
    await rpc(url, "anvil_setBalance", [address, toHex(plan.native)]);
    for (const token of plan.tokens) {
      await setTokenBalance(url, token.address, address, token.amount);
      funded.push(`${token.symbol} on ${chainId}`);
    }
  }
  return funded;
}

/** SOL and USDC for the throwaway Solana address (surfpool cheatcodes). */
export async function fundSolana(url, address) {
  await rpc(url, "surfnet_setAccount", [address, { lamports: SOLANA_FUNDING.lamports }]);
  await rpc(url, "surfnet_setTokenAccount", [address, SOLANA_FUNDING.usdcMint, { amount: SOLANA_FUNDING.usdcAmount }]);
}
