# Holiday: notes for coding agents

- The planning documents live in `docs/`. Start with `docs/README.md`, then `docs/PLAN.md`, `docs/decisions.md`, `docs/architecture.md`, the specs in `docs/specs/` and `docs/backlog.md`. When code and a spec disagree, the spec's owner file (see the document map in `docs/README.md`) wins unless the change is deliberate and the spec is updated in the same change.
- Never open, print or copy `.env` files or any other secret-bearing file, in this repository or any other.
- Stack: pnpm monorepo. `apps/web` (React 19, Vite, react-router), `apps/api` (Fastify), `apps/workers` (pg-boss consumers), `packages/core` (browser-safe zod schemas, types and holiday logic), `packages/server` (Node-only database, storage, queue, policy, ledger and provider adapters). ESM and strict TypeScript everywhere.
- Every external integration has a `fixture` mode, which is the default in development and tests. Tests never call live providers.
- Code comments describe the code. Do not reference backlog IDs, review findings or conversation context in comments.
- Before committing, run `pnpm typecheck`, `pnpm lint` and `pnpm test`.
