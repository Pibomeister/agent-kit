'use strict';

// Minimal static checks, run in CI as the `lint` required check:
//   no-undef-builtin   a Node built-in module is used without being required
//   no-console         console.* in src/ (scripts/ and bin/ may print)
const fs = require('node:fs');
const path = require('node:path');

const BUILTINS = ['fs', 'path', 'os', 'crypto', 'util', 'http', 'url'];
const root = path.join(__dirname, '..');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return p.endsWith('.js') ? [p] : [];
  });
}

const problems = [];
for (const file of [...walk(path.join(root, 'src')), ...walk(path.join(root, 'test'))]) {
  const rel = path.relative(root, file);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const source = lines.join('\n');
  for (const name of BUILTINS) {
    const required = new RegExp(`\\b(const|let|var)\\s+${name}\\s*=\\s*require\\(['"](node:)?${name}['"]\\)`).test(source);
    if (required) continue;
    lines.forEach((line, i) => {
      if (new RegExp(`(^|[^.\\w])${name}\\.\\w`).test(line)) {
        problems.push(`${rel}:${i + 1}  no-undef-builtin  '${name}' is used but never required`);
      }
    });
  }
  if (rel.startsWith(`src${path.sep}`)) {
    lines.forEach((line, i) => {
      if (/\bconsole\.\w+\(/.test(line)) problems.push(`${rel}:${i + 1}  no-console  console output in src/`);
    });
  }
}

for (const p of problems) console.log(p);
console.log(problems.length === 0 ? 'lint: clean' : `lint: ${problems.length} problem(s)`);
process.exit(problems.length === 0 ? 0 : 1);
