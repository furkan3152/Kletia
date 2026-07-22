import { encodeFunctionData, getAddress, parseEther } from 'viem';
import { ZORA_ERC721_DROP_ABI } from '../config/constants.js';

export async function handleNftMint(
    userAddress: string,
    collectionAddress: string | undefined,
    quantityStr: string | undefined
) {
    if (!collectionAddress) {
        throw new Error("Mintlemek istediğin Zora NFT koleksiyonunun adresini belirtmelisin.");
    }

    let targetAddress: `0x${string}`;
    try {
        targetAddress = getAddress(collectionAddress);
        if (targetAddress === "0x0000000000000000000000000000000000000000") throw new Error();
    } catch (e) {
        throw new Error("Geçerli bir NFT kontrat adresi girmelisin (0x...).");
    }

    const quantity = quantityStr ? parseInt(quantityStr) : 1;
    if (isNaN(quantity) || quantity <= 0) {
        throw new Error("Mintlenecek NFT adedini geçerli bir sayı olarak girmelisin.");
    }

    // Zora'nın standart mint ödülü (mint fee) genellikle 0.000777 ETH'dir.
    // Kullanıcının belirttiği adet kadar fee tahsil edilmelidir.
    const ZORA_MINT_FEE = 0.000777;
    const totalValue = parseEther((ZORA_MINT_FEE * quantity).toString());

    // Zora mintWithRewards fonksiyonu için calldata üretimi
    const mintCalldata = encodeFunctionData({
        abi: ZORA_ERC721_DROP_ABI,
        functionName: 'mintWithRewards',
        args: [
            getAddress(userAddress), // recipient
            BigInt(quantity),        // quantity
            "",                      // comment
            "0x0000000000000000000000000000000000000000" // mintReferral (Kletia referans verilebilir)
        ]
    });

    // Smart Router için sarıyoruz (Target Protocol: Koleksiyon Adresi)
    return {
        target: targetAddress,
        calldata: mintCalldata,
        value: totalValue,
        summary: `Zora üzerinden ${targetAddress} koleksiyonundan ${quantity} adet NFT mintlenecektir. Zora platform ücreti: ${ZORA_MINT_FEE * quantity} ETH.`
    };
}
