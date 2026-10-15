/**
 * GET /fees: revenue and claimable balances of every pinned or verified
 * Kletia contract. Pushed fees are summed from events with a
 * persisted, capped log scan; accrued balances come with their claim call.
 * One network failing never blanks the view (per-network errors).
 */
import {
  ADMIN_CONTRACTS,
  ADMIN_NETWORK_CONSTANTS,
  ASSETS,
  CHAINS,
  type AdminEvmNetwork,
  type AdminFeeRow,
  type AdminFeesView,
  type AdminTokenAmount,
} from "@kletia/core";
import { getAddress, isAddress, type AbiEvent, type Address } from "viem";
import { listKnownContracts, type KnownContract } from "./catalog.js";
import { getArtifact } from "./contract-artifacts/index.js";
import type { AdminDeps, AdminSessionContext } from "./deps.js";
import { AdminHttpError } from "./http/errors.js";
import { erc20Amount, nativeAmount, shortAddress } from "./state.js";
import { ownerKindOf, rpc, tryRead } from "./verify/chain.js";

export const FEE_SCAN_CHUNK = 10_000n;
export const FEE_SCAN_MAX_CHUNKS = 40;

const TESTNETS: readonly AdminEvmNetwork[] = ["arc", "arbitrum-sepolia"];

export function isTestnet(network: AdminEvmNetwork): boolean {
  return TESTNETS.includes(network);
}

function deploymentBlock(known: KnownContract): bigint | null {
  const block = known.record?.block ?? known.pinned?.block;
  return block ? BigInt(block) : null;
}

export function scanKeyOf(network: AdminEvmNetwork, address: string, event: string): string {
  return `${network}:${address.toLowerCase()}:${event}`;
}

export interface ScanResult {
  readonly scannedThroughBlock: bigint;
  readonly tip: bigint;
  readonly totals: Readonly<Record<string, string>>;
}

/** Continues the event scan of one pushed-fee contract by at most FEE_SCAN_MAX_CHUNKS chunks; the cursor persists after every chunk. */
export async function scanPushedFees(deps: AdminDeps, known: KnownContract): Promise<ScanResult | null> {
  const spec = ADMIN_CONTRACTS[known.contractId];
  if (spec.feeModel.kind !== "pushed") return null;
  const artifact = getArtifact(spec.artifactId);
  const fromDeployment = deploymentBlock(known);
  const eventName = spec.feeModel.event;
  const event = artifact?.abi.find((item): item is AbiEvent => item.type === "event" && item.name === eventName);
  if (!event || fromDeployment === null) return null;
  const store = deps.store();
  const key = scanKeyOf(known.network, known.address, eventName);
  const client = deps.client(known.network);
  const tip = await rpc(known.network, () => client.getBlockNumber());
  const saved = await store.getFeeScan(key);
  let cursor = saved ? saved.scannedThroughBlock : fromDeployment - 1n;
  const totals: Record<string, bigint> = {};
  for (const [token, amount] of Object.entries(saved?.totals ?? {})) totals[token] = BigInt(amount);
  const { amountField, tokenField } = spec.feeModel;
  for (let chunk = 0; chunk < FEE_SCAN_MAX_CHUNKS && cursor < tip; chunk += 1) {
    const fromBlock = cursor + 1n;
    const toBlock = fromBlock + FEE_SCAN_CHUNK - 1n < tip ? fromBlock + FEE_SCAN_CHUNK - 1n : tip;
    const logs = await rpc(known.network, () => client.getLogs({ address: known.address as Address, event, fromBlock, toBlock }));
    for (const log of logs) {
      const args = (log as unknown as { args: Record<string, unknown> }).args ?? {};
      const amount = args[amountField];
      if (typeof amount !== "bigint" || amount === 0n) continue;
      const tokenValue = tokenField ? args[tokenField] : null;
      const token = typeof tokenValue === "string" && isAddress(tokenValue, { strict: false }) ? tokenValue.toLowerCase() : "native";
      totals[token] = (totals[token] ?? 0n) + amount;
    }
    cursor = toBlock;
    await store.putFeeScan({
      key, network: known.network, address: known.address, scannedThroughBlock: cursor,
      totals: Object.fromEntries(Object.entries(totals).map(([token, amount]) => [token, amount.toString()])),
    });
  }
  return { scannedThroughBlock: cursor, tip, totals: Object.fromEntries(Object.entries(totals).map(([token, amount]) => [token, amount.toString()])) };
}

function isUsdStable(network: AdminEvmNetwork, token: string): boolean {
  const asset = ASSETS.find((entry) => entry.network === network && entry.address?.toLowerCase() === token.toLowerCase());
  if (!asset || asset.category !== "stablecoin") return false;
  return asset.group === "USDC" || asset.group === "USDT" || ["DAI", "USDbC", "USDC.e", "USDT0"].includes(asset.symbol);
}

async function priced(deps: AdminDeps, network: AdminEvmNetwork, amount: AdminTokenAmount, nativeUsd: () => Promise<number | null>): Promise<AdminTokenAmount> {
  if (isTestnet(network)) return { ...amount, usd: null };
  const units = Number(amount.amount) / 10 ** amount.decimals;
  if (amount.token === "native") {
    const price = await nativeUsd();
    return { ...amount, usd: price === null ? null : units * price };
  }
  if (isUsdStable(network, amount.token)) return { ...amount, usd: units };
  const wrapped = ADMIN_NETWORK_CONSTANTS[network].wrappedNative;
  if (wrapped && wrapped.toLowerCase() === amount.token.toLowerCase()) {
    const price = await nativeUsd();
    return { ...amount, usd: price === null ? null : units * price };
  }
  return amount;
}

async function tokenAmountFor(deps: AdminDeps, network: AdminEvmNetwork, token: string, amount: string): Promise<AdminTokenAmount> {
  if (token === "native") {
    const asset = CHAINS[network].nativeAsset;
    return { token: "native", symbol: asset.symbol, decimals: asset.decimals, amount, usd: null };
  }
  const known = ASSETS.find((entry) => entry.network === network && entry.address?.toLowerCase() === token.toLowerCase());
  if (known) {
    const wrapped = ADMIN_NETWORK_CONSTANTS[network].wrappedNative?.toLowerCase() === token.toLowerCase();
    return { token: getAddress(token), symbol: wrapped ? `${known.symbol} (paid as native)` : known.symbol, decimals: known.decimals, amount, usd: null };
  }
  const client = deps.client(network);
  const [symbol, decimals] = await Promise.all([
    tryRead(client, network, token, [{ type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }], "symbol"),
    tryRead(client, network, token, [{ type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }], "decimals"),
  ]);
  return { token: getAddress(token), symbol: symbol.ok ? String(symbol.value) : "TOKEN", decimals: decimals.ok ? Number(decimals.value) : 18, amount, usd: null };
}

interface ClaimContext {
  readonly actors: readonly string[];
}

async function claimFor(
  deps: AdminDeps, network: AdminEvmNetwork, owner: string | null, fn: string, ctx: ClaimContext, nothingToClaim: boolean,
): Promise<AdminFeeRow["claim"]> {
  if (!owner) return null;
  const actors = ctx.actors.map((actor) => actor.toLowerCase());
  const empty = nothingToClaim ? "Nothing to withdraw." : null;
  if (actors.includes(owner.toLowerCase())) return { fn, via: "direct", caller: getAddress(owner), blockedReason: empty };
  const kind = await ownerKindOf(deps.client(network), network, owner);
  if (kind.kind === "safe" && kind.safe?.owners.some((entry) => actors.includes(entry.toLowerCase()))) {
    return { fn, via: "safe", caller: getAddress(owner), blockedReason: empty };
  }
  return { fn, via: "direct", caller: getAddress(owner), blockedReason: `Owned by ${shortAddress(getAddress(owner))}. Connect that wallet or transfer ownership.` };
}

function baseRow(known: KnownContract, kind: AdminFeeRow["kind"]): Omit<AdminFeeRow, "amounts" | "recipient" | "claim"> {
  return {
    network: known.network, contractId: known.contractId, address: getAddress(known.address), kind,
    scannedThroughBlock: null, scanKey: null, blocksLeft: null, testnet: isTestnet(known.network), note: null,
  };
}

function configuredTreasury(env: NodeJS.ProcessEnv): string | null {
  const value = env.X402_TREASURY_ADDRESS?.trim();
  return value && isAddress(value, { strict: false }) ? getAddress(value) : null;
}

async function rowsFor(deps: AdminDeps, known: KnownContract, ctx: ClaimContext, nativeUsd: () => Promise<number | null>): Promise<AdminFeeRow[]> {
  const { network } = known;
  const spec = ADMIN_CONTRACTS[known.contractId];
  const artifact = getArtifact(spec.artifactId);
  const client = deps.client(network);
  const price = (amount: AdminTokenAmount) => priced(deps, network, amount, nativeUsd);
  switch (known.contractId) {
    case "intent-router-v2":
    case "launch-factory-v2": {
      const scan = await scanPushedFees(deps, known);
      const amounts = scan
        ? await Promise.all(Object.entries(scan.totals).map(async ([token, amount]) => price(await tokenAmountFor(deps, network, token, amount))))
        : [];
      const treasuryRead = artifact ? await tryRead(client, network, known.address, artifact.abi, "treasury") : { ok: false as const };
      const treasury = treasuryRead.ok && typeof treasuryRead.value === "string" ? getAddress(treasuryRead.value) : null;
      const left = scan ? scan.tip - scan.scannedThroughBlock : null;
      const pushed: AdminFeeRow = {
        ...baseRow(known, "pushed"), amounts, recipient: treasury, claim: null,
        scannedThroughBlock: scan ? scan.scannedThroughBlock.toString() : null,
        scanKey: spec.feeModel.kind === "pushed" ? scanKeyOf(network, known.address, spec.feeModel.event) : null,
        blocksLeft: left === null ? null : left.toString(),
        note: scan === null ? "Deployment block unknown; the event scan is off for this contract." : left && left > 0n ? `Scanning, ${left.toString()} blocks left.` : "Fees go to the treasury in each transaction.",
      };
      if (!treasury) return [pushed];
      const holdingTokens = new Set<string>(Object.keys(scan?.totals ?? {}).filter((token) => token !== "native"));
      const holdings: AdminTokenAmount[] = [await price(await nativeAmount(client, network, treasury))];
      for (const token of holdingTokens) {
        const amount = await erc20Amount(client, network, token, treasury);
        if (amount) holdings.push(await price(amount));
      }
      const actors = ctx.actors.map((actor) => actor.toLowerCase());
      let claim: AdminFeeRow["claim"] = null;
      let note: string | null = null;
      if (actors.includes(treasury.toLowerCase())) note = "The treasury is an admin wallet: the fees are already there.";
      else {
        const kind = await ownerKindOf(client, network, treasury);
        if (kind.kind === "safe" && kind.safe?.owners.some((owner) => actors.includes(owner.toLowerCase()))) {
          claim = { fn: "transfer", via: "safe", caller: treasury, blockedReason: null };
          note = "Move funds out of the treasury Safe with a Safe proposal.";
        } else note = `Treasury ${shortAddress(treasury)} is not controlled by an admin wallet.`;
      }
      const holding: AdminFeeRow = { ...baseRow(known, "treasury-holding"), address: treasury, amounts: holdings, recipient: treasury, claim, note };
      return [pushed, holding];
    }
    case "x402-gateway": {
      if (!artifact) return [];
      const usdc = await tryRead(client, network, known.address, artifact.abi, "usdc");
      const owner = await tryRead(client, network, known.address, artifact.abi, "owner");
      const amount = usdc.ok && typeof usdc.value === "string" ? await erc20Amount(client, network, usdc.value, known.address) : null;
      const amounts = amount ? [await price(amount)] : [];
      const empty = !amount || amount.amount === "0";
      const treasury = configuredTreasury(deps.env);
      return [{
        ...baseRow(known, "accrued"), amounts, recipient: treasury,
        claim: await claimFor(deps, network, owner.ok ? String(owner.value) : null, "withdraw", ctx, empty),
        note: treasury ? "withdraw(to) sends the whole balance; the default recipient is X402_TREASURY_ADDRESS." : "withdraw(to) sends the whole balance; the default recipient is your admin wallet.",
      }];
    }
    case "legacy-smart-router": {
      if (!artifact) return [];
      const owner = await tryRead(client, network, known.address, artifact.abi, "owner");
      const amounts: AdminTokenAmount[] = [await price(await nativeAmount(client, network, known.address))];
      const tokens = [ASSETS.find((asset) => asset.network === network && asset.symbol === "USDC")?.address, ADMIN_NETWORK_CONSTANTS[network].wrappedNative].filter((token): token is string => Boolean(token));
      for (const token of tokens) {
        const amount = await erc20Amount(client, network, token, known.address);
        if (amount) amounts.push(await price(amount));
      }
      const empty = amounts.every((amount) => amount.amount === "0");
      return [{
        ...baseRow(known, "accrued"), amounts, recipient: null,
        claim: await claimFor(deps, network, owner.ok ? String(owner.value) : null, "rescueTokens", ctx, empty),
        note: "Stray balances of the legacy fee router; rescueTokens(token, to, amount), token 0x0 for the native asset.",
      }];
    }
    case "arc-swap": {
      if (!artifact) return [];
      const [reserveUsdc, reserveToken, token] = await Promise.all([
        tryRead(client, network, known.address, artifact.abi, "reserveUSDC"),
        tryRead(client, network, known.address, artifact.abi, "reserveToken"),
        tryRead(client, network, known.address, artifact.abi, "token"),
      ]);
      const native = CHAINS[network].nativeAsset;
      const amounts: AdminTokenAmount[] = [];
      if (reserveUsdc.ok) amounts.push({ token: "native", symbol: native.symbol, decimals: native.decimals, amount: String(reserveUsdc.value), usd: null });
      if (reserveToken.ok && token.ok) amounts.push({ token: getAddress(String(token.value)), symbol: "KLET", decimals: 18, amount: String(reserveToken.value), usd: null });
      return [{ ...baseRow(known, "lp-only"), amounts, recipient: null, claim: null, note: "0.3 % of each swap stays in the pool for liquidity providers." }];
    }
    case "arc-vault-v2":
    case "arc-vault-v1":
    case "arc-staking": {
      if (!artifact || spec.feeModel.kind !== "owner-funded") return [];
      const balance = await nativeAmount(client, network, known.address);
      const required = known.contractId === "arc-vault-v2" ? await tryRead(client, network, known.address, artifact.abi, "requiredReserve") : null;
      const fundFn = spec.feeModel.fundFunction;
      const anyone = spec.actions.some((action) => action.fn === fundFn && action.caller === "anyone");
      let fund: AdminFeeRow["claim"];
      if (anyone) {
        const caller = ctx.actors[0] ?? null;
        fund = { fn: fundFn, via: "direct", caller: caller ?? "", blockedReason: caller ? null : "No EVM admin wallet is configured." };
      } else {
        const owner = await tryRead(client, network, known.address, artifact.abi, "owner");
        fund = await claimFor(deps, network, owner.ok ? String(owner.value) : null, fundFn, ctx, false);
      }
      return [{
        ...baseRow(known, "owner-funded"), amounts: [balance], recipient: null, claim: fund,
        note: required?.ok ? `Required reserve ${String(required.value)} base units. The owner funds this contract (a cost, not revenue).` : "The owner funds this contract (a cost, not revenue).",
      }];
    }
    case "x402-factory":
      return [{
        ...baseRow(known, "none"), amounts: [], recipient: configuredTreasury(deps.env), claim: null,
        note: "x402 premium API: paid directly to the x402 treasury address in each request. Nothing to claim.",
      }];
    default:
      return [];
  }
}

export async function feesView(deps: AdminDeps, session: AdminSessionContext): Promise<AdminFeesView> {
  const known = await listKnownContracts(deps.store());
  const ctx: ClaimContext = { actors: session.actors };
  const rows: AdminFeeRow[] = [];
  const errors: { network: AdminEvmNetwork; message: string }[] = [];
  const failed = new Set<AdminEvmNetwork>();
  const prices = new Map<AdminEvmNetwork, Promise<number | null>>();
  for (const contract of known) {
    if (failed.has(contract.network)) continue;
    const nativeUsd = () => {
      if (!prices.has(contract.network)) prices.set(contract.network, deps.nativeUsd(contract.network).catch(() => null));
      return prices.get(contract.network) as Promise<number | null>;
    };
    try {
      rows.push(...await rowsFor(deps, contract, ctx, nativeUsd));
    } catch (error) {
      if (error instanceof AdminHttpError && error.code === "ADMIN_STORE_UNAVAILABLE") throw error;
      failed.add(contract.network);
      errors.push({ network: contract.network, message: error instanceof AdminHttpError ? error.message : `The ${contract.network} reads failed.` });
    }
  }
  return { rows, totals: feeTotals(rows), asOf: deps.now().toISOString(), errors };
}

/** USD totals: pushed and accrued rows, testnets excluded, unpriced non-zero mainnet amounts counted. */
export function feeTotals(rows: readonly AdminFeeRow[]): AdminFeesView["totals"] {
  let pushedUsd = 0;
  let accruedUsd = 0;
  let unpricedTokens = 0;
  for (const row of rows) {
    if (row.testnet) continue;
    for (const amount of row.amounts) {
      if (amount.usd === null) {
        if (amount.amount !== "0" && (row.kind === "pushed" || row.kind === "accrued")) unpricedTokens += 1;
        continue;
      }
      if (row.kind === "pushed") pushedUsd += amount.usd;
      else if (row.kind === "accrued") accruedUsd += amount.usd;
    }
  }
  return { pushedUsd, accruedUsd, unpricedTokens };
}

/** POST /fees/rescan: continues one scan now. */
export async function rescan(deps: AdminDeps, key: string): Promise<string> {
  const match = /^([a-z-]+):(0x[0-9a-f]{40}):([A-Za-z]+)$/u.exec(key);
  if (!match) throw new AdminHttpError(400, "ADMIN_INVALID_REQUEST", "key must be <network>:<address>:<event>.");
  const known = (await listKnownContracts(deps.store())).find((entry) => scanKeyOf(entry.network, entry.address, ADMIN_CONTRACTS[entry.contractId].feeModel.kind === "pushed" ? (ADMIN_CONTRACTS[entry.contractId].feeModel as { event: string }).event : "") === key);
  if (!known) throw new AdminHttpError(404, "ADMIN_NOT_FOUND", "No fee scan has this key.");
  const result = await scanPushedFees(deps, known);
  if (!result) throw new AdminHttpError(422, "ADMIN_INVALID_REQUEST", "This contract has no scannable fee events.");
  return result.scannedThroughBlock.toString();
}
