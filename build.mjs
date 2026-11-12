import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const target = process.argv[2];
const watch = process.argv.includes('--watch');
if (target !== 'chrome' && target !== 'firefox') {
  console.error('Usage: node build.mjs <chrome|firefox> [--watch]');
  process.exit(1);
}

const outdir = resolve('dist', target);
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

function copyStatic() {
  cpSync(resolve('manifests', `${target}.json`), resolve(outdir, 'manifest.json'));
  for (const f of ['popup/popup.html', 'popup/popup.css', 'options/options.html', 'options/options.css']) {
    cpSync(resolve('src', f), resolve(outdir, f));
  }
  cpSync(resolve('icons'), resolve(outdir, 'icons'), { recursive: true });
}

const options = {
  entryPoints: {
    'background': 'src/background/index.ts',
    'content': 'src/content/index.ts',
    'popup/popup': 'src/popup/popup.ts',
    'options/options': 'src/options/options.ts',
  },
  outdir,
  bundle: true,
  format: 'iife',
  target: ['chrome110', 'firefox140'],
  sourcemap: watch ? 'inline' : false,
  define: { __BROWSER__: JSON.stringify(target) },
  logLevel: 'info',
  plugins: [{ name: 'copy-static', setup(b) { b.onEnd(() => copyStatic()); } }],
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
