# Missing import chain in Vite dev

Use Node 24 and run `npm install && npm run dev`. The example uses published `impound@1.2.1` and Vite 8.3.4.

The script starts a Vite dev server and requests `entry.js`, `a.js`, and `b.js`. The modules form this chain:

```text
entry.js -> a.js -> b.js -> secret.js
```

Impound forbids importing `secret.js` and has `trace: true`. The report is emitted while the dev server is running, but published impound omits the import chain:

```text
Reports while dev server is running: 1
Import chain: (missing)
```

Expected: the report contains `entry.js -> a.js -> b.js`. The script exits with code 1 while the chain is missing. With the proposed Vite dev graph change, it prints the chain and exits successfully.
