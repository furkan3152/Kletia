const fs = require('fs');
const path = './frontend/src/components/widgets/ArcDashboardWidget.tsx';
let content = fs.readFileSync(path, 'utf8');

const replacements = [
  ["prompt: 'Transfer 50 USDC to my Arc vault immediately, I want to earn interest'", "prompt: 'Transfer 50 USDC to my Kletia vault on Arc network immediately, I want to earn interest'"],
  ["prompt: 'Add 10 USDC liquidity to Swap pool on Arc network'", "prompt: 'Add 10 USDC liquidity to Kletia Swap pool on Arc network'"],
  ["prompt: 'Lock 25 USDC to Arc staking contract for the future'", "prompt: 'Lock 25 USDC to Kletia staking contract on Arc network for the future'"]
];

for (const [find, replace] of replacements) {
  content = content.split(find).join(replace);
}

fs.writeFileSync(path, content, 'utf8');
console.log('Replaced in ArcDashboardWidget.tsx');
