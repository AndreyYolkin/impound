# Repeated hard-error reproduction

Run `npm install && npm run dev`. The example uses published `impound@1.2.0` and Vite 6.

The script starts a Vite dev server with an impound rule that forbids importing `secret.js`. It requests `entry.js` twice. Between requests it edits `entry.js` and invalidates Vite's module graph, as happens during development. Both versions of `entry.js` still import the forbidden file.

Expected: both requests are **blocked**.

Observed on `impound@1.2.0`:

```text
First request (forbidden import): blocked
Second request (same import after edit): allowed
Expected: blocked on both requests
```

The script exits with code 1 while the bug is present. With the proposed fix, the second request is also blocked and the script exits successfully.
