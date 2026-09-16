# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Read `STATUS.md` first for the current state, then `docs/SPEC.md`, `docs/PRIMER.md` and `docs/BRIEF.md`; the handoff traps in `docs/SPEC.md` section 7 corrupt data when skipped.
- Validation is `pnpm check` (lint, typecheck, unit tests, web build), `pnpm test:db` against a dedicated test Postgres in `TEST_DATABASE_URL` (never production, never port 5432 by habit; run it on Postgres 17 and 18 because CI is 17 and Railway is 18), and `pnpm test:e2e`. Database suites must report zero skips.
- Chain evidence is content-hashed per batch and replayed before commit; new sources add an evidence variant beside the existing ones (see `packages/db/src/broad.ts` and `packages/chain/src/hypersync-broad.ts`) rather than restructuring a serializer or a stream.
- The tier-2 swap history stream is `swaps:broad:v1`; its HyperSync backfill is a manual, off-by-default command documented in `docs/HYPERSYNC-BACKFILL.md` with recorded fixtures under `packages/chain/src/fixtures/hypersync/`. Key names live in `.env.example`; never print a key value.
- Never reset or mutate the `discovery:v1` cursor, never run collection against Alchemy or HyperSync without the captain's word, and keep `transaction_sender` labelled as an initiator, not a beneficiary.
- Database timings are measured in two places on purpose. Every Homebrew Postgres on the development machine is built without LLVM (`pg_jit_available()` is false), while CI's `postgres:17` image and Railway's Postgres 18 image have JIT and compile large plans on every request. Reads keep `jit` off in `beginRead` in `apps/api/src/reader.ts`; a Postgres 17 or 18 test server used through `TEST_DATABASE_URL` shows plan shape and version-specific planner behaviour, and the `tier2 server`, `tier2 read` and `tier2 plan` lines the scale test prints in the CI log are the only JIT-inclusive measurements. `TIER2_JIT` and `TIER2_EXPLAIN` in `apps/api/src/tier2-scale.integration.test.ts` switch on A/B runs and plan dumps.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
