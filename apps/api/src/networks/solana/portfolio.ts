import { address } from "@solana/kit";
import { findAssetByAddress, fromBaseUnits, isSolanaAddress, WRAPPED_SOL_MINT } from "@kletia/core";
import { SOLANA_PROGRAMS, type SolanaNetworkKey } from "./config.js";
import { SolanaProviderError, isRecord } from "./http.js";
import { rpcAbortSignal, solanaRpc } from "./rpc.js";
import { readSolanaPrices, resolveSolanaToken } from "./tokens.js";

export interface SolanaHolding {
  readonly mint: string;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly amount: string;
  readonly formatted: string;
  readonly usdPrice: number | null;
  readonly usdValue: number | null;
  readonly change24h: number | null;
  readonly tokenProgram: "spl-token" | "token-2022";
  readonly verified: boolean;
  readonly isNative: boolean;
}

export interface SolanaPortfolio {
  readonly network: SolanaNetworkKey;
  readonly owner: string;
  readonly totalUsd: number;
  readonly holdings: readonly SolanaHolding[];
  readonly unpricedCount: number;
  readonly observedAt: string;
  readonly slot: string;
}

interface ParsedTokenAccount {
  mint: string;
  amount: string;
  decimals: number;
  tokenProgram: "spl-token" | "token-2022";
}

function parseTokenAccount(value: unknown, tokenProgram: "spl-token" | "token-2022"): ParsedTokenAccount | null {
  if (!isRecord(value)) return null;
  const account = value.account;
  if (!isRecord(account) || !isRecord(account.data)) return null;
  const parsed = (account.data as Record<string, unknown>).parsed;
  if (!isRecord(parsed) || !isRecord(parsed.info)) return null;
  const info = parsed.info as Record<string, unknown>;
  const tokenAmount = info.tokenAmount;
  if (typeof info.mint !== "string" || !isRecord(tokenAmount)) return null;
  if (typeof tokenAmount.amount !== "string" || typeof tokenAmount.decimals !== "number") return null;
  if (!/^\d+$/u.test(tokenAmount.amount)) return null;
  return { mint: info.mint, amount: tokenAmount.amount, decimals: tokenAmount.decimals, tokenProgram };
}

const MAX_TOKEN_ACCOUNTS = 200;

export async function readSolanaPortfolio(network: SolanaNetworkKey, owner: string): Promise<SolanaPortfolio> {
  if (!isSolanaAddress(owner)) {
    throw new SolanaProviderError("A valid Solana address is required.", "SOLANA_ADDRESS_INVALID", 400);
  }
  const rpc = solanaRpc(network);
  const ownerAddress = address(owner);
  const [balance, legacy, token2022] = await Promise.all([
    rpc.getBalance(ownerAddress, { commitment: "confirmed" }).send({ abortSignal: rpcAbortSignal() }),
    rpc
      .getTokenAccountsByOwner(
        ownerAddress,
        { programId: address(SOLANA_PROGRAMS.token) },
        { encoding: "jsonParsed", commitment: "confirmed" },
      )
      .send({ abortSignal: rpcAbortSignal() }),
    rpc
      .getTokenAccountsByOwner(
        ownerAddress,
        { programId: address(SOLANA_PROGRAMS.token2022) },
        { encoding: "jsonParsed", commitment: "confirmed" },
      )
      .send({ abortSignal: rpcAbortSignal() }),
  ]).catch((error: unknown) => {
    throw new SolanaProviderError(
      `Solana RPC read failed: ${error instanceof Error ? error.message.slice(0, 120) : "unknown"}`,
      "SOLANA_RPC_UNAVAILABLE",
    );
  });

  const accounts = [
    ...legacy.value.map((entry) => parseTokenAccount(entry, "spl-token")),
    ...token2022.value.map((entry) => parseTokenAccount(entry, "token-2022")),
  ].filter((entry): entry is ParsedTokenAccount => entry !== null && entry.amount !== "0");

  // Merge multiple accounts for one mint and cap the work for very large wallets.
  const byMint = new Map<string, ParsedTokenAccount>();
  for (const entry of accounts) {
    const existing = byMint.get(entry.mint);
    byMint.set(
      entry.mint,
      existing ? { ...existing, amount: (BigInt(existing.amount) + BigInt(entry.amount)).toString() } : entry,
    );
  }
  const tokenEntries = [...byMint.values()].slice(0, MAX_TOKEN_ACCOUNTS);

  const prices =
    network === "solana"
      ? await readSolanaPrices([WRAPPED_SOL_MINT, ...tokenEntries.map((entry) => entry.mint)]).catch(
          () => new Map<string, { usd: number; change24h?: number }>(),
        )
      : new Map<string, { usd: number; change24h?: number }>();

  const holdings: SolanaHolding[] = [];
  const lamports = balance.value.toString();
  const solPrice = prices.get(WRAPPED_SOL_MINT);
  const solFormatted = fromBaseUnits(lamports, 9);
  holdings.push({
    mint: WRAPPED_SOL_MINT,
    symbol: "SOL",
    name: "Solana",
    decimals: 9,
    amount: lamports,
    formatted: solFormatted,
    usdPrice: solPrice?.usd ?? null,
    usdValue: solPrice ? Number(solFormatted) * solPrice.usd : null,
    change24h: solPrice?.change24h ?? null,
    tokenProgram: "spl-token",
    verified: true,
    isNative: true,
  });

  const canonicalFirst = tokenEntries.sort(
    (a, b) => Number(Boolean(findAssetByAddress(network, b.mint))) - Number(Boolean(findAssetByAddress(network, a.mint))),
  );
  const resolved = await Promise.all(
    canonicalFirst.map(async (entry, index) => {
      // Metadata lookups beyond the first 25 unknown mints are skipped to bound latency.
      const known = findAssetByAddress(network, entry.mint);
      const info = known || index < 25 ? await resolveSolanaToken(network, entry.mint).catch(() => null) : null;
      return { entry, info };
    }),
  );
  for (const { entry, info } of resolved) {
    const price = prices.get(entry.mint);
    const formatted = fromBaseUnits(entry.amount, entry.decimals);
    holdings.push({
      mint: entry.mint,
      symbol: info?.symbol ?? `${entry.mint.slice(0, 4)}…${entry.mint.slice(-4)}`,
      name: info?.name ?? "Unknown token",
      decimals: entry.decimals,
      amount: entry.amount,
      formatted,
      usdPrice: price?.usd ?? null,
      usdValue: price ? Number(formatted) * price.usd : null,
      change24h: price?.change24h ?? null,
      tokenProgram: entry.tokenProgram,
      verified: info?.verified ?? false,
      isNative: false,
    });
  }

  holdings.sort((a, b) => (b.usdValue ?? -1) - (a.usdValue ?? -1));
  return {
    network,
    owner,
    totalUsd: holdings.reduce((total, holding) => total + (holding.usdValue ?? 0), 0),
    holdings,
    unpricedCount: holdings.filter((holding) => holding.usdValue === null).length,
    observedAt: new Date().toISOString(),
    slot: balance.context.slot.toString(),
  };
}
