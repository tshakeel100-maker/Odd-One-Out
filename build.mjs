import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(path.join(root, 'index.html'), path.join(dist, 'index.html'));
const functionBuild = await build({
  entryPoints: [path.join(root, 'netlify/functions/game.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  external: ['@netlify/blobs'],
  write: false,
  metafile: true,
});
if (!functionBuild.outputFiles.length || !functionBuild.metafile.outputs) {
  throw new Error('Netlify function did not produce a production bundle.');
}
console.log('Built dist/index.html and verified the bundled Netlify function.');
