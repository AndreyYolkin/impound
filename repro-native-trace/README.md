# Missing import chains and positions with webpack and rspack

Use Node 26 and run `npm ci && npm run dev`. This uses published `impound@1.2.1`, webpack 5.111.1, and rspack 2.2.7.

Each case builds `entry.js -> a.js -> b.js -> secret.js`. Impound denies `secret.js`. The script checks both `trace: true` (Nuxt dev mode) and `trace: 'lazy'` (Nuxt build mode) with direct, extensionless, aliased, and mixed imports.

The expected trace for each case is `entry.js:1:8 -> a.js:1:8 -> b.js`. The current release gives a chain without positions for direct imports in `trace: true`, no chain for extensionless or aliased imports in `trace: true`, and a chain without positions for extensionless imports in `trace: 'lazy'`.

The script prints each result and exits with code 1 until all chains and positions match the expectation. It also checks that each compilation really reports the denied import.
