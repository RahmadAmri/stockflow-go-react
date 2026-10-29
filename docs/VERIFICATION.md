# Verification record

Verified on **29 October 2026 (Asia/Jakarta)** using macOS arm64, Go 1.25.5, Node.js 24.11.0, PostgreSQL 16.8 (Postgres.app), and installed Google Chrome.

A separate temporary PostgreSQL cluster was initialized on localhost port 55432 for this work. The application ran against its actual PostgreSQL database; integration tests created and removed isolated schemas. Existing databases were not modified.

| Check | Result |
| --- | --- |
| `TEST_DATABASE_URL=… go test -race -count=1 -v ./...` | Passed: 12 top-level test groups, including 5 validation subcases; database tests ran, not skipped |
| `go vet ./...` | Passed |
| `npm test` | Passed: 29 Vitest cases |
| `npm run build` | Passed: strict TypeScript checking (app, config, and browser tests) and Vite production build |
| `PLAYWRIGHT_CHROME_CHANNEL=chrome … npm run test:e2e` | Passed: all 3 real-backend browser workflows |
| Live `/api/health`, product listing, and summary | Passed |
| Desktop (1440 px) and mobile (390 px) browser inspection | Passed; no browser JavaScript errors or document-wide horizontal overflow |
| Fresh migrations, repeated migrations, seeds | Passed; 14 products, 2 orders, stock reconciles with movements, totals reconcile with items, no duplicate seeds |

Database tests include stock overdraw with no writes, successful adjustments, multi-item insufficiency, a forced second-item database failure after earlier writes, price snapshots, validation and integer limits, history protection, 24 simultaneous orders for 10 units, concurrent cancellations, and reversed-order multi-product locking. The forced-failure test intentionally logs one database error and verifies full rollback.

Browser tests cover product creation/editing, successful adjustment, actual API 409 errors, failed-SKU highlighting, order creation and server totals, cancellation and visibly restored stock, retained history, inactive filtering, loading/empty/error/retry states, order browsing, and a mobile viewport. Loading and network-failure tests delay/abort real requests; they do not substitute inventory responses.

Follow-up deletion-dialog verification on 29 October 2026: the production build, 29 Vitest cases, and all **5** browser workflows passed. The browser suite now verifies permanent deletion with HTTP 204 for products without history, direct deactivation with stock/history preserved, an already-inactive product's explanation, and a real HTTP 409 when another client adds a movement after the deletion dialog opens. These checks used a separate temporary PostgreSQL schema and test API/Vite ports, leaving the working inventory untouched.

## Limits

- Docker is not installed in this execution environment, so image builds, Compose health checks, and the nginx container have **not** been executed here. The full application was verified with local Go, Node, and real PostgreSQL. To verify the container path: `docker compose up --build -d --wait`, then `E2E_BASE_URL=http://localhost:3000 npm run test:e2e` from `frontend/`.
- The GitHub Actions workflow was added but has not run on GitHub.
- These tests validate a local application, not a production load test or a security audit. Authentication, order idempotency, and daily sales reports remain outside the implemented scope.
- No claim is made that this AI-assisted implementation meets the assignment's prohibition on AI-generated code. See the root README disclosure.
