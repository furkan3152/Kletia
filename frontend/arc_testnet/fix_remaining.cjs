const fs = require('fs');
const path = require('path');

const dir = './src';

const replacements = {
  "görevini tamamladı.": "completed its task.",
  "Alınan Debt:": "Borrowed Debt:",
  "Yüksek Risk": "High Risk",
  "Düşük": "Low",
  "Connectılıyor...": "Connecting...",
  "UYARI: Kletia Otonom Ajanı ve Kletia Safek Duvarı bu adresle herhangi bir işlem yapmanıza izin vermeyecektir.": "WARNING: Kletia Autonomous Agent and Kletia Firewall will not allow you to make any transaction with this address.",
  "Zamanlanmış / Koşullu Emir": "Scheduled / Conditional Order"
};

function processDirectory(directory) {
  const files = fs.readdirSync(directory);
  for (const file of files) {
    const fullPath = path.join(directory, file);
    if (fs.statSync(fullPath).isDirectory()) {
      processDirectory(fullPath);
    } else if (fullPath.endsWith('.ts') || fullPath.endsWith('.tsx')) {
      let content = fs.readFileSync(fullPath, 'utf8');
      let changed = false;
      for (const [tr, en] of Object.entries(replacements)) {
        if (content.includes(tr)) {
          content = content.split(tr).join(en);
          changed = true;
        }
      }
      if (changed) {
        fs.writeFileSync(fullPath, content, 'utf8');
        console.log('Fixed:', fullPath);
      }
    }
  }
}

processDirectory(dir);
