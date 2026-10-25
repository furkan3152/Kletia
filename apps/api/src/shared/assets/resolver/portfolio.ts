/**
 * Verified Base portfolio discovery (Alchemy, ERC-20 metadata checks).
 */
import {
  erc20Abi,
  getAddress,
  keccak256,
  zeroAddress,
  type Address,
  type PublicClient,
} from "viem";
import {
  compareAssetReferenceSimilarity,
  assetReferenceIdentityKey,
  normalizeAssetReference,
} from "../catalog.js";
import { EntityResolutionError, type VerifiedPortfolioAsset } from "./types.js";

function boundedMetadata(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== "string") {
    throw new EntityResolutionError(
      "ERC20_METADATA_INVALID",
      `Token ${field} data is not in standard string format.`,
    );
  }
  let normalized: string;
  try {
    normalized = normalizeAssetReference(value);
  } catch {
    throw new EntityResolutionError(
      "ERC20_METADATA_UNSAFE",
      `Token ${field} data contains invisible or control characters.`,
    );
  }
  if (normalized.length > maxLength) {
    throw new EntityResolutionError(
      "ERC20_METADATA_TOO_LONG",
      `Token ${field} data exceeds secure display limit.`,
    );
  }
  return normalized;
}

export async function verifyBaseErc20(
  addressInput: string,
  user: Address,
  client: PublicClient,
): Promise<Omit<VerifiedPortfolioAsset, "similarity" | "exactMatch">> {
  let address: Address;
  try {
    address = getAddress(addressInput);
  } catch {
    throw new EntityResolutionError(
      "INVALID_TOKEN_ADDRESS",
      "Token contract address is not a valid EVM address.",
    );
  }
  if (address === zeroAddress) {
    throw new EntityResolutionError(
      "ZERO_TOKEN_ADDRESS",
      "Zero address cannot be used as a token contract.",
    );
  }

  const observedAtBlock = await client.getBlockNumber();
  const bytecode = await client.getBytecode({
    address,
    blockNumber: observedAtBlock,
  });
  if (!bytecode || bytecode === "0x") {
    throw new EntityResolutionError(
      "TOKEN_CODE_MISSING",
      "The entered address does not contain contract bytecode on this Base block.",
    );
  }

  let symbolRaw: string;
  let nameRaw: string;
  let decimals: number;
  let balance: bigint;
  let totalSupply: bigint;
  try {
    [symbolRaw, nameRaw, decimals, balance, totalSupply] = await Promise.all([
      client.readContract({
        address,
        abi: erc20Abi,
        functionName: "symbol",
        blockNumber: observedAtBlock,
      }),
      client.readContract({
        address,
        abi: erc20Abi,
        functionName: "name",
        blockNumber: observedAtBlock,
      }),
      client.readContract({
        address,
        abi: erc20Abi,
        functionName: "decimals",
        blockNumber: observedAtBlock,
      }),
      client.readContract({
        address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [user],
        blockNumber: observedAtBlock,
      }),
      client.readContract({
        address,
        abi: erc20Abi,
        functionName: "totalSupply",
        blockNumber: observedAtBlock,
      }),
    ]);
  } catch {
    throw new EntityResolutionError(
      "ERC20_INTERFACE_UNVERIFIED",
      "The address's standard ERC-20 metadata, balance, and supply interface could not be verified at the same block.",
    );
  }

  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new EntityResolutionError(
      "ERC20_DECIMALS_UNSAFE",
      "Token decimals value is not within the safe range of 0-36.",
    );
  }
  if (totalSupply <= 0n) {
    throw new EntityResolutionError(
      "ERC20_SUPPLY_INVALID",
      "Token total supply is not positive.",
    );
  }

  return {
    symbol: boundedMetadata(symbolRaw, "symbol", 24),
    name: boundedMetadata(nameRaw, "name", 64),
    address,
    decimals,
    balance,
    observedAtBlock,
    codeHash: keccak256(bytecode),
  };
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await worker(items[index]);
      }
    }),
  );
  return results;
}

export async function withinDeadline<T>(
  operation: Promise<T>,
  deadline: number,
  code: string,
): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new EntityResolutionError(
      code,
      "Onchain token verification time exceeded the safe request budget.",
      503,
    );
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new EntityResolutionError(
                code,
                "Onchain token verification time exceeded the safe request budget.",
                503,
              ),
            ),
          remaining,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function alchemyRpc(
  url: string,
  method: string,
  params: readonly unknown[],
  timeoutMs = 4_000,
): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
    signal: AbortSignal.timeout(Math.max(250, timeoutMs)),
  });
  if (!response.ok) throw new Error(`alchemy_http_${response.status}`);
  const body = await response.json();
  if (body?.error) throw new Error("alchemy_provider_error");
  return body?.result;
}

async function discoverBasePortfolioAssets(
  reference: string,
  user: Address,
  client: PublicClient,
): Promise<readonly VerifiedPortfolioAsset[]> {
  const deadline = Date.now() + 6_000;
  const key = process.env.ALCHEMY_API_KEY?.trim();
  if (!key) return [];
  const url = `https://base-mainnet.g.alchemy.com/v2/${key}`;

  let balanceResult: unknown;
  try {
    balanceResult = await alchemyRpc(
      url,
      "alchemy_getTokenBalances",
      [user, "erc20"],
      4_000,
    );
  } catch {
    return [];
  }
  const records =
    balanceResult &&
    typeof balanceResult === "object" &&
    Array.isArray(
      (balanceResult as { tokenBalances?: unknown[] }).tokenBalances,
    )
      ? (balanceResult as { tokenBalances: unknown[] }).tokenBalances
      : [];

  const allAddresses = [
    ...new Set(
      records
        .flatMap((record): Address[] => {
          if (!record || typeof record !== "object") return [];
          const raw = record as {
            contractAddress?: unknown;
            tokenBalance?: unknown;
          };
          try {
            if (BigInt(String(raw.tokenBalance)) <= 0n) return [];
            return [getAddress(String(raw.contractAddress))];
          } catch {
            return [];
          }
        })
        .map((address) => address.toLowerCase()),
    ),
  ].map((address) => getAddress(address));

  const addresses =
    allAddresses.length <= 32
      ? allAddresses
      : Array.from(
          { length: 32 },
          (_value, index) =>
            allAddresses[Math.floor((index * (allAddresses.length - 1)) / 31)],
        );

  const hints = await mapWithConcurrency(addresses, 8, async (address) => {
    try {
      const remaining = deadline - Date.now();
      if (remaining <= 250) return null;
      const metadata = await alchemyRpc(
        url,
        "alchemy_getTokenMetadata",
        [address],
        Math.min(2_000, remaining),
      );
      if (!metadata || typeof metadata !== "object") return null;
      const raw = metadata as { symbol?: unknown; name?: unknown };
      const symbol = typeof raw.symbol === "string" ? raw.symbol : "";
      const name = typeof raw.name === "string" ? raw.name : "";
      const similarity = Math.max(
        symbol ? compareAssetReferenceSimilarity(reference, symbol) : 0,
        name ? compareAssetReferenceSimilarity(reference, name) : 0,
      );
      const exactMatch = [symbol, name].some((value) => {
        try {
          return (
            value &&
            assetReferenceIdentityKey(value) ===
              assetReferenceIdentityKey(reference)
          );
        } catch {
          return false;
        }
      });
      return similarity >= 0.68 || exactMatch
        ? { address, similarity, exactMatch }
        : null;
    } catch {
      return null;
    }
  });

  const shortlist = hints
    .filter((hint): hint is NonNullable<typeof hint> => hint !== null)
    .sort(
      (left, right) =>
        Number(right.exactMatch) - Number(left.exactMatch) ||
        right.similarity - left.similarity,
    )
    .slice(0, 6);

  const verified = await mapWithConcurrency(shortlist, 4, async (hint) => {
    try {
      if (Date.now() >= deadline) return null;
      const asset = await withinDeadline(
        verifyBaseErc20(hint.address, user, client),
        deadline,
        "PORTFOLIO_ASSET_VERIFICATION_TIMEOUT",
      );
      const exactMatch = [asset.symbol, asset.name].some(
        (value) =>
          assetReferenceIdentityKey(value) ===
          assetReferenceIdentityKey(reference),
      );
      const similarity = Math.max(
        compareAssetReferenceSimilarity(reference, asset.symbol),
        compareAssetReferenceSimilarity(reference, asset.name),
      );
      if (asset.balance <= 0n || (!exactMatch && similarity < 0.68))
        return null;
      return { ...asset, exactMatch, similarity };
    } catch {
      return null;
    }
  });
  return verified
    .filter((asset): asset is VerifiedPortfolioAsset => asset !== null)
    .sort(
      (left, right) =>
        Number(right.exactMatch) - Number(left.exactMatch) ||
        right.similarity - left.similarity ||
        left.address.localeCompare(right.address),
    );
}

const portfolioDiscoveryCache = new Map<
  string,
  {
    readonly expiresAt: number;
    readonly promise: Promise<readonly VerifiedPortfolioAsset[]>;
  }
>();

export function discoverBasePortfolioAssetsCached(
  reference: string,
  user: Address,
  client: PublicClient,
): Promise<readonly VerifiedPortfolioAsset[]> {
  const cacheKey = `${user.toLowerCase()}:${assetReferenceIdentityKey(reference)}`;
  const cached = portfolioDiscoveryCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  if (portfolioDiscoveryCache.size >= 200) {
    const oldest = portfolioDiscoveryCache.keys().next().value;
    if (oldest) portfolioDiscoveryCache.delete(oldest);
  }
  const promise = discoverBasePortfolioAssets(reference, user, client);
  portfolioDiscoveryCache.set(cacheKey, {
    expiresAt: Date.now() + 30_000,
    promise,
  });
  promise.catch(() => {
    if (portfolioDiscoveryCache.get(cacheKey)?.promise === promise) {
      portfolioDiscoveryCache.delete(cacheKey);
    }
  });
  return promise;
}
