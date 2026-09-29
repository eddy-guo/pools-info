# Screener stats visual evidence

Captured from the same local production build at 1440 x 1000 and 390 x 844.

- `before-*`: fixture deployment with no stats route, so no card row.
- `after-mock-*`: local API serving the contract-shaped stats example; all other product reads came from the fixture deployment. The figures are illustrative, not production measurements.

The production read API returned HTTP 404 for `GET /v1/stats?window=24h` on 29 Sep 2026. Browser coverage for present, incomplete, 503, and 404 answers uses the local mock in `tests/e2e/screener-stats.spec.ts`.
