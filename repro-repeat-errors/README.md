# Repeated hard-error reproduction

Run `npm install` and `npm start` in this directory. The example uses published `impound@1.2.0`.

Expected: both attempts to import `secret` fail when the same plugin instance is used for two builds.

Observed on `impound@1.2.0`: the first attempt fails, but the second succeeds. The script prints both outcomes and exits with code 1 while the bug is present.
