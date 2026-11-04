// acde-host's two bundles, what crates/acde runs: dist/broker.js (the Broker, src/main.ts) and dist/isolate.js (a desktop or window isolate's
// thread, src/isolate.ts with acde-dom). ES modules for V8 itself: no Node, nothing external; workspace packages from
// their sources (the `source` condition). Whitespace and syntax are minified (every isolate compiles isolate.js);
// identifiers keep their names, so stack traces stay readable, and the source maps map back.
//
//   bun scripts/bundle.mjs         in the package directory (its `bundle` script)
import { build } from 'esbuild'

await build({
  entryPoints: { broker: 'src/main.ts', isolate: 'src/isolate.ts' },
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
