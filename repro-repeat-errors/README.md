# Repeated hard-error reproduction

Run `npm install` and `npm start` in this directory. The example uses published `impound@1.2.0`.

Expected: both Vite dev requests fail when they import `secret`.

Observed on `impound@1.2.0`: the first request fails, but after an edit and module invalidation the second succeeds. The script prints both outcomes and exits with code 1 while the bug is present.
