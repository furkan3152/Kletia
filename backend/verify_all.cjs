const hre = require("hardhat");

const contracts = [
  { name: "Swap", address: "0x535EF89e3C3a74Cf1A76703972686cb7a2e34fe8", args: ["0x7de7a249673f2235a91e484cfce49d00867b67ec", "0xAe77D247c26258397653a020995E957Bc88E039A"] },
  { name: "Lending", address: "0x2748a478Ec0f6D90FfdE89b27721f469126835F7", args: ["0x7de7a249673f2235a91e484cfce49d00867b67ec", "0xAe77D247c26258397653a020995E957Bc88E039A", "0x535EF89e3C3a74Cf1A76703972686cb7a2e34fe8"] },
  { name: "Token", address: "0xAe77D247c26258397653a020995E957Bc88E039A", args: ["Kletia Token", "KLET", "1000000000000000000000000000", "0x8c5281055B197443Ff01dbbdfBF29fD63946CA1E", "0x8c5281055B197443Ff01dbbdfBF29fD63946CA1E"] },
  { name: "BatchPay", address: "0x09B6d2987EcAF021533A2727d2967696595Fa6dd", args: ["0x7de7a249673f2235a91e484cfce49d00867b67ec", 100] },
  { name: "Vault", address: "0xe2810DB53998f8A51bBf5Bf94c21208b174da174", args: ["0x7de7a249673f2235a91e484cfce49d00867b67ec", 1000] },
  { name: "MemoTransfer", address: "0x1633f12f31195B34feE6eDC250e1D543DAB72698", args: ["0x7de7a249673f2235a91e484cfce49d00867b67ec"] },
  { name: "AgentRegistry", address: "0xDEb07309c1689fEeCa44ac70939ce0297d511596", args: ["0x7de7a249673f2235a91e484cfce49d00867b67ec"] },
  { name: "Staking", address: "0xB85a7F6335D0544b4951e5f07Bcd326722b2BC07", args: ["0x7de7a249673f2235a91e484cfce49d00867b67ec", 1000, 604800] },
  { name: "OTC", address: "0xf4c1F168491F22222145cff88414fE489BF8c39d", args: ["0x7de7a249673f2235a91e484cfce49d00867b67ec"] }
];

async function main() {
  for (const c of contracts) {
    console.log(`\nVerifying ${c.name} at ${c.address}...`);
    try {
      await hre.run("verify:verify", {
        address: c.address,
        constructorArguments: c.args
      });
      console.log(`${c.name} verified successfully.`);
    } catch (e) {
      console.log(`Failed to verify ${c.name}:`, e.message);
    }
  }
}
main().catch(console.error);
