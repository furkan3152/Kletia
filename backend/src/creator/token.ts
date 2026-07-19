import { encodeFunctionData, parseEther } from 'viem';
import { ROUTERS, KLETIA_TOKEN_FACTORY_ABI } from '../config/constants.js';

export async function handleTokenDeployment(
    userAddress: string,
    name: string | undefined,
    symbol: string | undefined,
    supplyStr: string | undefined
) {
    if (!name || !symbol) {
        throw new Error("Token oluşturmak için bir isim (name) ve sembol (symbol) belirtmelisin. Örn: 'Kletia Coin oluştur sembolü KLT olsun'");
    }

    const supply = supplyStr ? parseFloat(supplyStr) : 1000000; // Varsayılan 1 milyon arz
    if (isNaN(supply) || supply <= 0) {
        throw new Error("Geçerli bir arz miktarı belirtmelisin.");
    }

    // Toplam arzı 18 ondalıklı BigInt'e çeviriyoruz
    const totalSupplyBigInt = parseEther(supply.toString());

    // Fabrika kontratının createToken fonksiyonu için calldata üretimi
    const factoryCalldata = encodeFunctionData({
        abi: KLETIA_TOKEN_FACTORY_ABI,
        functionName: 'createToken',
        args: [name, symbol, totalSupplyBigInt]
    });

    // Smart Router için sarıyoruz (Target Protocol: Token Factory)
    // Deploy için ekstra ETH yollamıyoruz (Value = 0)
    return {
        target: ROUTERS.KLETIA_TOKEN_FACTORY,
        calldata: factoryCalldata,
        value: 0n,
        summary: `Kletia Özel Token Fabrikasında '${name}' (${symbol}) adında ${supply.toLocaleString()} arzlı yeni bir token yaratılacak. Arzın %10'u Hazine'ye kesilecektir.`
    };
}
