# Virtual importer reproduction

Run `npm install` and `npm start` in this directory. The example uses published `impound@1.2.0`.

Expected: an import from a virtual module is blocked.

Observed on `impound@1.2.0`: the virtual module imports the forbidden module. The script prints the outcome and exits with code 1 while the bug is present.
