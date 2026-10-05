# Playwright complex failure example

This consumer project installs the repository build of `dev-blackbox`. It models
a checkout flow spanning catalog, customer, promotion, inventory, API, and browser
layers. A VIP promotion adds `GIFT-SLEEVE`, but the warehouse repository has no row
for that SKU. The resulting `TypeError` is intentional.

```bash
npm install
npx playwright install chromium
npm run test:e2e:blackbox
npx dev-blackbox incident list --format json
npx dev-blackbox network list --failed --format json
```

The Playwright command is expected to exit with code 1. A correct run records:

- the root `TypeError` at `inventory-service.mjs`;
- the Playwright process failure;
- frontend and backend HTTP 500 events sharing one trace ID;
- deduplicated occurrences instead of a new incident for the same fingerprint.

To measure the current one-file-per-run behavior in an isolated temporary folder:

```bash
npm run audit:file-growth -- 105
```

The audit is executable: it fails unless 105 identical failures merge into one
incident, retain one latest log blob and one report, and keep at most 100 command
session files.
