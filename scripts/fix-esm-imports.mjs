import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';

function fixImports(dir) {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      fixImports(fullPath);
    } else if (extname(entry) === '.js' || extname(entry) === '.mjs') {
      let content = readFileSync(fullPath, 'utf-8');
      
      // Replace relative imports without extensions
      content = content.replace(
        /from\s+(['"])\.\/([^'"]+)\1/g,
        (match, quote, path) => {
          if (path.endsWith('.js') || path.endsWith('.mjs')) return match;
          
          // Check if it's a directory with index.js
          const dirPath = join(dirname(fullPath), path);
          if (existsSync(dirPath) && statSync(dirPath).isDirectory()) {
            return `from ${quote}./${path}/index.js${quote}`;
          }
          
          return `from ${quote}./${path}.js${quote}`;
        }
      );
      
      // Replace dynamic imports
      content = content.replace(
        /import\s*\(\s*(['"])\.\/([^'"]+)\1\s*\)/g,
        (match, quote, path) => {
          if (path.endsWith('.js') || path.endsWith('.mjs')) return match;
          
          const dirPath = join(dirname(fullPath), path);
          if (existsSync(dirPath) && statSync(dirPath).isDirectory()) {
            return `import(${quote}./${path}/index.js${quote})`;
          }
          
          return `import(${quote}./${path}.js${quote})`;
        }
      );
      
      writeFileSync(fullPath, content);
    }
  }
}

fixImports('./dist/esm');
