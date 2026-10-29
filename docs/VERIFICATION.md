# Verification record

Latest verification: **29 October 2026 (Asia/Jakarta)**. Environment: macOS arm64, Go 1.25.5, Node.js 24.11.0, PostgreSQL 16.8 (Postgres.app), and Google Chrome.

The browser suite ran against a fresh, compiled **production frontend**, served by Vite preview with `/api` proxied to the real Go API. Its database was an isolated PostgreSQL schema on separate API/preview ports. Backend tests created their own isolated schemas. The working inventory was not used for test mutations, and the user's API and Vite processes were left running.

## Results

| Check | Result |
| --- | --- |
| Real PostgreSQL `go test -race -count=1 -v ./...` | **Passed: 17 top-level test groups**, plus 13 validation/error-handling subcases; database tests ran, not skipped |
| `go vet ./...` | Passed |
| Fresh `npm ci` in a separate checkout copy | Passed; dependency installation did not depend on the existing node_modules |
| `npm test` | **Passed: 29 Vitest cases** |
| `npm run build` | Passed: strict TypeScript checks and Vite production build |
| Playwright against the production build + real Go/PostgreSQL | **Passed: all 8 browser workflows** |
| Linux amd64 backend build with `CGO_ENABLED=0` | Passed |
| Official Docker Compose `config --quiet` | Passed |
| Fresh migrations and repeat startup | Passed; 14 products, 2 orders, no duplicated seed rows, stock and order totals reconcile with history/items |
| Existing local app health through Vite | HTTP 200 |

## Assignment coverage

| Required behavior | Evidence |
| --- | --- |
| Product CRUD, validation, unique SKU, missing-product 404 | PostgreSQL API tests and real-browser create/edit/delete flows |
| Permanent deletion returns 204 only without history; history returns 409 | API tests and browser deletion/deactivation tests, including history added after the dialog opens |
| Nullable `last_movement_at`, newest-first movement history | API behavior and browser history checks after adjustment, sale, and cancellation |
| Debounced SKU/name search, pagination, All/Active/Inactive/Low-stock filters | Browser checks using more than one page of products, case-insensitive search, filter transitions, and a product crossing the low-stock threshold |
| Loading, empty, error, and retry states | Browser request-delay and connection-abort scenarios; real responses are forwarded, not mocked |
| Positive integer stock adjustment and visible 409 availability | Unit/API tests and browser overdraw flow |
| Empty/duplicate/unknown/invalid order items rejected before writes | PostgreSQL validation tests and frontend pure-logic tests |
| Server unit prices and totals | Price-snapshot API test and browser multi-item order after a price changes in another session |
| Multi-item atomicity; nothing written on insufficiency or SQL failure | PostgreSQL tests, including a forced second-item database failure after writes have begun |
| No overselling under concurrent orders | 24 simultaneous orders for 10 units: exactly 10 succeed; stock remains nonnegative |
| Consistent lock ordering | Concurrent multi-item orders supplied in opposite SKU order |
| Cancellation restores all items only once | API cancellation-race tests and browser checks; stock-limit failure leaves the whole cancellation unapplied |
| Order 400 and SKU-specific 409 displayed in UI | Browser checks against real inactive-product validation and multi-item stock conflicts |
| Global summary totals refreshed after mutations | Browser assertions after deletion, adjustment, deactivation, sale, and cancellation; search/filter/pagination do not narrow summary totals |
| Real API client, shared types, strict TypeScript, no domain `any` | Source review, single fetch boundary in `src/api.ts`, strict production build |
| Seed data, migrations, README, commits, hours | 14 seeded products and 2 sample orders, repeat-migration test, documented commands/design decisions, actual local commits; **5 human hours reported by the user** |

## Fixes made during the review

- Status changes now use `PATCH /api/products/{id}/status`, updating only `is_active`. Deactivating an older table row no longer overwrites another editor's newer name or price.
- Startup reserves the listening port before announcing readiness. A second API process receives an actionable port error. Shutdown waits for active requests before closing the database pool.
- The Vitest exclusion pattern is quoted, preventing the shell from expanding multiple Playwright files into unintended Vitest arguments.
- CI now has a separate Compose job that builds all three services and runs the browser suite against nginx on port 3000, in addition to the PostgreSQL/API/unit/build checks.

## Verification limits and submission conditions

- **Container execution is not verified locally.** The Docker Engine is unavailable here. Compose configuration validates, the backend cross-compiles for Linux, and the production frontend works against Go/PostgreSQL, but these checks do not replace executing the Docker images and nginx. The new Compose CI job is configured but has not run on GitHub.
- To verify containers: `docker compose up --build -d --wait`, then from `frontend/`: `E2E_BASE_URL=http://localhost:3000 npm run test:e2e`. Stop any services already occupying the Compose host ports or change those mappings first.
- Idempotency keys and daily-sales reporting are **optional bonuses not implemented**. Authentication and production deployment hardening remain outside this local take-home scope.
- The assignment prohibits AI-generated code. This repository explicitly discloses AI assistance and cannot be presented as meeting that restriction without evaluator permission. The reported 5 hours describe the user's own work, not a claim of AI-free authorship.
