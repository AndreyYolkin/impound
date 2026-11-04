# Missing import chains in webpack and rspack dev traces

Use Node 26 and run `npm ci && npm run dev`. This uses published `impound@1.2.1`, webpack 5.111.1, and rspack 2.2.7.

Each case builds `entry.js -> a.js -> b.js -> secret.js`. Impound denies `secret.js`. The script checks `trace: true` (Nuxt dev mode) with direct, extensionless, aliased, mixed, and named imports.

Every case should report the full `entry.js -> a.js -> b.js` chain. Direct imports and aliases with an extension should also have positions (`entry.js:1:8 -> a.js:1:8 -> b.js`). The published release gives a chain without positions for direct imports and no chain for extensionless or aliased imports. Positions for extensionless imports are covered by a separate lazy-trace fix.

The script prints all ten results and exits with code 1 until the chains and applicable positions match. It also checks that each compilation reports exactly one denied-import error, including for a named import.

To check a locally built impound candidate, set `IMPOUND_ENTRY` to the absolute path of its `dist/index.mjs` before running `npm run dev`.
