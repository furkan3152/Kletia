const fs = require('fs');
const path = './backend/src/intent/arc_handlers.ts';
let content = fs.readFileSync(path, 'utf8');

const replacements = [
  ['winner: "Arc Native Swap"', 'winner: "Kletia Swap"'],
  ['name: "Arc Omni Swap"', 'name: "Kletia Swap"'],
  ['winner: "Arc Native Staking"', 'winner: "Kletia Staking"'],
  ['name: "Arc Batch Pay", router: ARC_CONTRACTS.BatchPay, calldata, expectedOutput: "Multi Payment"', 'name: "Kletia Staking", router: ARC_CONTRACTS.Staking, calldata, expectedOutput: "Stake KLET"'],
  ['winner: "Arc Vault"', 'winner: "Kletia Vault"'],
  ['name: "Arc Secured Vault"', 'name: "Kletia Vault"'],
  ['winner: "Arc Memo Transfer"', 'winner: "Kletia Memo Transfer"'],
  ['name: "Arc Memo Transfer"', 'name: "Kletia Memo Transfer"'],
  ['winner: "Arc Agent Registry"', 'winner: "Kletia Agent Registry"'],
  ['name: "Arc Agent Registry"', 'name: "Kletia Agent Registry"'],
  ['winner: "Arc Liquidity Pool"', 'winner: "Kletia Liquidity Pool"'],
  ['name: "Arc Omni Liquidity"', 'name: "Kletia Liquidity"'],
  ['winner: "Arc Lending"', 'winner: "Kletia Lending"'],
  ['name: "Arc Lending"', 'name: "Kletia Lending"']
];

for (const [find, replace] of replacements) {
  content = content.split(find).join(replace);
}

fs.writeFileSync(path, content, 'utf8');
console.log('Replaced in arc_handlers.ts');
