import { getAddress } from "viem";

export async function handleNftMint(
  _userAddress: string,
  collectionAddress: string | undefined,
  quantityStr: string | undefined,
): Promise<never> {
  if (!collectionAddress) {
    throw new Error(
      "Mintlemek istediğin Zora NFT koleksiyonunun adresini belirtmelisin.",
    );
  }

  let targetAddress: `0x${string}`;
  try {
    targetAddress = getAddress(collectionAddress);
    if (targetAddress === "0x0000000000000000000000000000000000000000")
      throw new Error();
  } catch (e) {
    throw new Error("Geçerli bir NFT kontrat adresi girmelisin (0x...).");
  }

  const quantity = quantityStr ? parseInt(quantityStr) : 1;
  if (isNaN(quantity) || quantity <= 0) {
    throw new Error(
      "Mintlenecek NFT adedini geçerli bir sayı olarak girmelisin.",
    );
  }

  throw Object.assign(
    new Error(
      `NFT minting for ${targetAddress} (${quantity} item) is unavailable until the collection's live mint configuration and exact value can be verified.`,
    ),
    { code: "LIVE_MINT_QUOTE_REQUIRED", statusCode: 501 },
  );
}
