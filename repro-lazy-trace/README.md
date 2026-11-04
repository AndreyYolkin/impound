# Missing positions for extensionless imports in lazy traces

Use Node 26 and run `npm ci && npm run dev`. This installs the published `impound@1.2.1` and builds with Vite 8.3.5, webpack 5.111.1, and rspack 2.2.7.

Each case imports `entry.js -> a.js -> b.js -> secret.js`. Impound denies `secret.js` with `trace: 'lazy'`. The script checks direct imports, imports without an extension, aliases with an extension, and aliases without an extension mixed with relative imports.

Every trace should contain `entry.js:1:8 -> a.js:1:8 -> b.js`. On the published release, direct imports and aliases with an extension have positions, while imports without an extension have a chain without positions. All builds still report the denied import.

The script prints all 12 results and exits with code 1 until every trace has the expected positions.

To check a locally built impound candidate, set `IMPOUND_ENTRY` to the absolute path of its `dist/index.mjs` before running `npm run dev`.
