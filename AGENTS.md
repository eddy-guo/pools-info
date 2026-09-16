# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Read `STATUS.md` first for the current state, then `docs/SPEC.md`, `docs/PRIMER.md` and `docs/BRIEF.md`; the handoff traps in `docs/SPEC.md` section 7 corrupt data when skipped.
- Validation is `pnpm check` (lint, typecheck, unit tests, web build), `pnpm test:db` against a dedicated test Postgres in `TEST_DATABASE_URL` (never production, never port 5432 by habit; run it on Postgres 17 and 18 because CI is 17 and Railway is 18), and `pnpm test:e2e`. Database suites must report zero skips. `pnpm test:db` ends with a serial scale phase (`apps/api/src/broad-explore.scale.test.ts`) whose printed `52k catalog serving` line in the CI log is the serving-latency number that counts: CI's runner has 2 vCPUs and Postgres JIT, local Homebrew Postgres has neither, so never add a `--test-concurrency` flag and keep latency-asserting tests in that phase (see `docs/BROAD-MARKET-SERVING.md`). The market browser suite is `pnpm test:e2e:market` (needs `TEST_DATABASE_URL`; its ports derive from the base port, pinned with `PLAYWRIGHT_MARKET_PORT` and `MARKET_API_PORT`). `pnpm test:e2e` derives its web server port per copy of the repo (`webServerPort` in `playwright.config.ts`, announced on each run, overridable with `PLAYWRIGHT_WEB_PORT`) and reuses a server already on it, which is your own worktree's: restart it after rebuilding or the suite silently grades the previous build.
- The read API's JSON types are a contract with the website's response validators in `apps/web/src/lib` (`pool-response.ts`, `live-feed.ts`, `following-response.ts`, `trade-share-response.ts`): node-postgres returns bigint columns as strings, so block heights and on-chain timestamps must be converted with `Number(...)` while exact wei and raw token amounts stay strings (`apps/api/README.md` "HTTP contract"). API integration tests import those validators directly; keep it that way so the boundary cannot drift silently.
- Chain evidence is content-hashed per batch and replayed before commit; new sources add an evidence variant beside the existing ones (see `packages/db/src/broad.ts` and `packages/chain/src/hypersync-broad.ts`) rather than restructuring a serializer or a stream.
- The tier-2 swap history stream is `swaps:broad:v1`; its HyperSync backfill is a manual, off-by-default command documented in `docs/HYPERSYNC-BACKFILL.md` with recorded fixtures under `packages/chain/src/fixtures/hypersync/`. Key names live in `.env.example`; never print a key value.
- On-demand wallet history (`/v1/wallets/:address/history`) is explorer data from the Blockscout PRO API, served for display only and never joined to accounting or PnL; the key, cap, TTL variables and the per-process credit budget are documented in `apps/api/README.md`.
- Never reset or mutate the `discovery:v1` cursor, never run collection against Alchemy or HyperSync without the captain's word, and keep `transaction_sender` labelled as an initiator, not a beneficiary.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
