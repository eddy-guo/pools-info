# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Database timings are measured in two places on purpose. Every Homebrew Postgres on the development machine is built without LLVM (`pg_jit_available()` is false), while CI's `postgres:17` image and Railway's Postgres 18 image have JIT and compile large plans on every request. Reads keep `jit` off in `beginRead` in `apps/api/src/reader.ts`; a Postgres 17 or 18 test server used through `TEST_DATABASE_URL` shows plan shape and version-specific planner behaviour, and the `tier2 server`, `tier2 read` and `tier2 plan` lines the scale test prints in the CI log are the only JIT-inclusive measurements. `TIER2_JIT` and `TIER2_EXPLAIN` in `apps/api/src/tier2-scale.integration.test.ts` switch on A/B runs and plan dumps.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
