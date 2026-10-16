# Virtual importer reproduction

Run `npm install` and `npm start` in this directory. The example uses published `impound@1.2.0`.

Expected: an import from a virtual module is blocked by both Rollup and Rolldown.

Observed on `impound@1.2.0`: both bundlers allow the forbidden import from the virtual module. The script prints both outcomes and exits with code 1 while the bug is present.
