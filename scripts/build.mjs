import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'dist');
try {
  if (fs.lstatSync(output).isSymbolicLink()) throw new Error('Refusing symlinked dist/.');
  try { fs.lstatSync(path.join(output, 'data')); throw new Error('Refusing dist/data/. Move persistent records outside dist before building.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
} catch (error) { if (error.code !== 'ENOENT') throw error; }
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
await Promise.all([
  build({ absWorkingDir: root, entryPoints: ['src/main.tsx'], outfile: path.join(output, 'main.js'), bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, legalComments: 'eof', define: { 'process.env.NODE_ENV': '"production"' } }),
  build({ absWorkingDir: root, entryPoints: ['src/backend.ts'], outfile: path.join(output, 'backend.cjs'), bundle: true, format: 'cjs', platform: 'node', target: 'node22', minify: true, legalComments: 'eof' }),
]);
for (const [from, to] of [['manifest.json', 'manifest.json'], ['src/styles.css', 'styles.css'], ['README.md', 'README.md'], ['LICENSE', 'LICENSE']]) fs.copyFileSync(path.join(root, from), path.join(output, to));
fs.cpSync(path.join(root, 'docs', 'screenshots'), path.join(output, 'docs', 'screenshots'), { recursive: true });
console.log('Built Question Patterns in dist/ (frontend, backend, styles, manifest and README screenshots). Persistent data was not touched.');
