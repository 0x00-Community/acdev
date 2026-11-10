// acde-host's bundles, what crates/acde runs: dist/broker.js (the Broker, src/main.ts), dist/isolate.js (a desktop or window isolate's
// thread, src/isolate.ts with acde-dom) and dist/kernel.js (the same isolate in /dev/jsrt's V8, src/kernel.ts; its natives
// cross the rings, kinds from scripts/natives-table.mjs). ES modules for V8 itself: no Node, nothing external but jsrt:host; workspace packages from
// their sources (the `source` condition). Whitespace and syntax are minified (every isolate compiles isolate.js);
// identifiers keep their names, so stack traces stay readable, and the source maps map back.
//
//   bun scripts/bundle.mjs         in the package directory (its `bundle` script)
import { build } from 'esbuild'
import './natives-table.mjs'

await build({
  entryPoints: { broker: 'src/main.ts', isolate: 'src/isolate.ts', kernel: 'src/kernel.ts' },
  external: ['jsrt:host'],
  outdir: 'dist',
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2024',
  conditions: ['source'],
  mainFields: ['module', 'main'],
  sourcemap: 'linked',
  minifyWhitespace: true,
  minifySyntax: true,
  legalComments: 'none',
  logLevel: 'info',
})
