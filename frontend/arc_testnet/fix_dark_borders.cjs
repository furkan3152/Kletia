const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, 'src/components');

function walk(directory) {
  let files = fs.readdirSync(directory);
  for (let file of files) {
    let fullPath = path.join(directory, file);
    if (fs.statSync(fullPath).isDirectory()) {
      walk(fullPath);
    } else if (fullPath.endsWith('.tsx') || fullPath.endsWith('.ts')) {
      let content = fs.readFileSync(fullPath, 'utf8');
      let newContent = content
        .replace(/dark:border-slate-600/g, 'dark:border-white')
        .replace(/dark:border-slate-500/g, 'dark:border-white')
        .replace(/dark:shadow-\[([^\]]+)_#475569\]/g, 'dark:shadow-[$1_#fff]')
        .replace(/dark:shadow-\[([^\]]+)_#333\]/g, 'dark:shadow-[$1_#fff]')
        .replace(/dark:shadow-\[([^\]]+)_#222\]/g, 'dark:shadow-[$1_#fff]')
        .replace(/dark:md:shadow-\[([^\]]+)_#475569\]/g, 'dark:md:shadow-[$1_#fff]');
      if (newContent !== content) {
        fs.writeFileSync(fullPath, newContent, 'utf8');
        console.log(`Updated ${fullPath}`);
      }
    }
  }
}

walk(dir);
console.log('Finished updating dark mode borders and shadows.');
