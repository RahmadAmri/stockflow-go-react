# StockFlow — Inventory & Sales

A working React + TypeScript / Go / PostgreSQL inventory application. The frontend calls the real Go API; products, stock movements, prices, orders, and summary totals come from PostgreSQL. Includes 14 seeded products and two sample orders with corresponding stock movements.

**Assignment disclosure:** the supplied assignment explicitly prohibits AI-generated code. This implementation was generated with AI assistance and should be treated as a reference/learning implementation unless the evaluator explicitly permits it. It cannot truthfully be represented as independently written work. The original brief is preserved in [docs/ASSIGNMENT.txt](docs/ASSIGNMENT.txt).

## Run with Docker (recommended)

Prerequisite: Docker Engine/Desktop with Compose v2 running. From the repository root:

```sh
docker compose up --build -d --wait
```

- App: **http://localhost:3000**
- API: **http://localhost:8080/api/health**
- PostgreSQL: `localhost:5432`, user/password/database: `stockflow`

The backend waits for PostgreSQL, applies embedded SQL migrations and seed data, then starts serving. The frontend waits for a healthy API. Migrations are transactional, versioned, and protected by an advisory lock; restarts do not duplicate seeds. Data persists in the Compose volume. Initial builds require internet access to download images and dependencies.

```sh
docker compose logs -f backend  # startup or database problems
docker compose down            # stop; keep your inventory
```

To **permanently delete the local demo database** and reseed from scratch:

```sh
docker compose down -v
docker compose up --build -d --wait
```

All published ports bind to localhost. This is a local demo without authentication; do not expose it publicly as-is. If a port is already occupied, change the host side of that port mapping or stop the conflicting service.

## Run with local Go and Node

Prerequisites: Go 1.25+, Node.js 24 (tested), npm, and PostgreSQL 16+. Dependencies are locked in `go.sum` and `package-lock.json`.

Start only the database:

```sh
docker compose up -d --wait db
```

Then use two terminals, both starting in the repository root:

```sh
# Terminal 1 — migrations, seed, and API
cd backend
go run ./cmd/api
```

```sh
# Terminal 2 — React development server
cd frontend
npm ci
npm run dev
```

Open the Vite URL, normally **http://localhost:5173**. `/api` is proxied to `http://127.0.0.1:8080`, so no permissive CORS configuration is needed. Docker's nginx uses the same `/api` path.

With an existing PostgreSQL server, create a dedicated `stockflow` database and set `DATABASE_URL` before starting Go:

```sh
export DATABASE_URL='postgres://your_user:your_password@127.0.0.1:5432/stockflow?sslmode=disable'
cd backend
go run ./cmd/api
```

The database role needs permission to create tables for automatic migrations. The Go service defaults to `127.0.0.1:8080`; `HTTP_ADDR` overrides it. If you change the API address, set `API_PROXY_TARGET` when starting Vite, for example `API_PROXY_TARGET=http://127.0.0.1:8081 npm run dev`.

After Go code changes, press **Ctrl+C** in the existing backend terminal and run `go run ./cmd/api` again; Go does not reload automatically. Run one API instance on port 8080. Vite's `ECONNREFUSED` means the API is not listening; `address already in use` means another instance already owns the port. Browser-aborted requests (for example, obsolete searches or page reloads) are normal cancellations. The API skips their responses and error logs; a server request exceeding its deadline returns `504 REQUEST_TIMEOUT` and logs a warning.

## What is implemented

- Product create/edit/delete; active/inactive status; paginated, case-insensitive search by SKU or name; All / Active / Inactive / Low stock filters applied **before** pagination. The deletion dialog offers direct deactivation for products with history; products without history can be permanently deleted. Deactivated products remain under All products and Inactive.
- Integer IDR prices and positive integer stock adjustments, with stock history and a visible insufficient-stock error containing the available quantity.
- Multi-item sales orders using server-side price snapshots and totals. Invalid SKUs, inactive products, duplicate SKUs, invalid quantities, and empty orders are rejected before writes.
- Atomic stock consumption and movement history; concurrent orders cannot oversell. Cancellation restores every item once, records inbound movements, and retains all historical records.
- Order browsing/detail, cancellation confirmation, and automatic inventory/summary refresh after successful mutations.
- Global summary cards (total products, active products, stock value, and low-stock count), loading skeletons, empty states, retryable fetch errors, responsive tables, keyboard-accessible native dialogs, and debounced search with stale-request cancellation.

## API contract and examples

Every error uses `{"error":{"code":"...","message":"..."}}`. Validation can include `fields`; stock conflicts include `available` and `sku`. Successful deletes return **204 without a body**. Send JSON with `Content-Type: application/json`. Unknown JSON properties are rejected, including client-supplied prices in order items and direct stock changes in product CRUD.

| Method | Endpoint | Result |
| --- | --- | --- |
| GET | `/api/products?search=&page=1&limit=20&filter=all` | `{data, page, limit, total}`; each product includes nullable `last_movement_at` |
| POST | `/api/products` | 201, created product with zero stock |
| PUT | `/api/products/{id}` | 200, updated product; 404 if absent |
| DELETE | `/api/products/{id}` | 204; 409 `PRODUCT_HAS_HISTORY` if referenced by history |
| POST | `/api/products/{id}/stock` | 200, updated product; 409 `INSUFFICIENT_STOCK` on overdraw |
| GET | `/api/products/{id}/movements` | `{data: [...]}`, newest first; 404 if product absent |
| POST | `/api/orders` | 201, order including `items`, `unit_price`, and `total` |
| GET | `/api/orders/{id}` | Order detail; 404 if absent |
| POST | `/api/orders/{id}/cancel` | Updated order; 409 `ORDER_ALREADY_CANCELLED` on repeat |
| GET | `/api/orders?page=1&limit=20` | Additional endpoint: paginated order summaries, newest first |
| GET | `/api/summary` | Additional endpoint: global inventory summary |
| GET | `/api/health` | 200 when database is reachable, otherwise 503 |

`page` is 1–1,000,000; `limit` is 1–100. Filters are `all`, `active`, `inactive`, and `low`. SKUs are case-sensitive identifiers; search is case-insensitive and treats `%` and `_` literally. Price and stock are bounded by PostgreSQL `INTEGER` (2,147,483,647); order totals above this limit are rejected. An order accepts 1–100 distinct items.

```sh
# Search and filter; summary always includes the full inventory.
curl 'http://localhost:8080/api/products?search=kopi&page=1&limit=10&filter=active'
curl 'http://localhost:8080/api/summary'

# Create product (use the returned id in subsequent requests).
curl -i http://localhost:8080/api/products \
  -H 'Content-Type: application/json' \
  -d '{"sku":"COF-003","name":"Toraja Coffee 250 g","price":90000,"is_active":true}'

# Update an existing seeded product.
curl -i -X PUT http://localhost:8080/api/products/1 \
  -H 'Content-Type: application/json' \
  -d '{"sku":"COF-001","name":"Kopi Arabika Gayo · 250 g","price":85000,"is_active":true}'

# Add stock (inventory and movement are committed together).
curl -i http://localhost:8080/api/products/1/stock \
  -H 'Content-Type: application/json' \
  -d '{"type":"in","qty":10,"note":"Supplier delivery"}'

# Deliberately overdraw: response is 409 with available quantity.
curl -i http://localhost:8080/api/products/1/stock \
  -H 'Content-Type: application/json' \
  -d '{"type":"out","qty":999999,"note":"Conflict example"}'

curl http://localhost:8080/api/products/1/movements

# Create an order. Only customer, SKU, and quantity come from the client.
curl -i http://localhost:8080/api/orders \
  -H 'Content-Type: application/json' \
  -d '{"customer":"Kedai Pagi","items":[{"sku":"COF-001","qty":2},{"sku":"CUP-001","qty":1}]}'

# Replace 3 with the created order's id.
curl http://localhost:8080/api/orders/3
curl -i -X POST http://localhost:8080/api/orders/3/cancel

# History prevents deletion; expect 409 PRODUCT_HAS_HISTORY.
curl -i -X DELETE http://localhost:8080/api/products/1
```

Example insufficient-order-stock response:

```json
{
  "error": {
    "code": "INSUFFICIENT_STOCK",
    "message": "Insufficient stock for COF-001",
    "sku": "COF-001",
    "available": 3
  }
}
```

`/api/summary` returns `total_stock_value` as a **decimal string**, formatted with `BigInt` in the UI, so aggregates exceeding JavaScript's safe integer range remain exact. Individual prices, quantities, and order totals remain integer JSON numbers as specified.

## Data safety and design decisions

1. **Transactions and locks.** Order creation locks all requested products with `SELECT … ORDER BY sku FOR UPDATE`, validates all items, then writes the order, its items, stock decrements, and movements in one transaction. Decrements additionally have `WHERE stock >= qty`. Adjustment and cancellation use the same product locks; cancellation first locks the order, so competing cancellation requests restore stock only once. Multi-product operations acquire product locks in the same order to reduce deadlocks. Database constraints are a final backstop. See [PostgreSQL's locking documentation](https://www.postgresql.org/docs/16/explicit-locking.html).
2. **Historical integrity.** Order item prices are immutable snapshots. Changing a product's name, price, or active status does not change an existing order. SKU changes are blocked once history exists, and products with history can be deactivated rather than deleted. Cancellation can restore inactive products. There are no history-delete endpoints or cascading deletes.
3. **Stock authority.** New products start at zero. Stock changes only through adjustment, order, and cancellation transactions. Seed opening balances and sample orders have matching movement records. `last_movement_at` is derived with `MAX(created_at)` over the indexed movements table, avoiding a second stored timestamp that could drift.
4. **Consistent listing.** Counts and rows in each paginated list use a repeatable-read transaction. Summary totals use a single aggregate query over all products, independent of page/search/filter. Low stock means `stock <= 10`, including inactive products. Stock value includes inactive inventory and uses current sale price, not inventory cost accounting.
5. **Cross-stack errors.** `frontend/src/types.ts` holds domain/API types; `api.ts` owns every fetch call and envelope parsing. Components display validation fields, the failing SKU, and availability. Aborted obsolete searches cannot overwrite newer results. Mutations are not automatically retried.
6. **Small deployment.** Go's standard HTTP router plus pgx; React/Vite with strict TypeScript; no global state library or ORM. [Vite's development proxy](https://vite.dev/config/server-options.html#server-proxy) and nginx keep browser requests same-origin. The UI uses system font fallbacks if Google Fonts is unavailable.

## Verification

Backend integration tests use a real PostgreSQL server, create a unique schema per test, and remove only those schemas afterward. `TEST_DATABASE_URL` is separate from the app URL. Without it, database integration tests are explicitly **skipped**; a passing unit-only invocation is not evidence that database safety was tested.

```sh
# Host Go + the Compose database:
cd backend
TEST_DATABASE_URL='postgres://stockflow:stockflow@localhost:5432/stockflow?sslmode=disable' \
  go test -race -count=1 -v ./...
go vet ./...
```

Or run backend tests entirely in containers from the repository root:

```sh
docker compose --profile test run --rm backend-test
```

Frontend validation and production build:

```sh
cd frontend
npm ci
npm test
npm run build
```

Real browser workflows (requires Go and a PostgreSQL database; these tests create data in the configured **development/test** database):

```sh
cd frontend
npx playwright install chromium
DATABASE_URL='postgres://stockflow:stockflow@localhost:5432/stockflow?sslmode=disable' npm run test:e2e
```

Playwright starts/reuses the local API and Vite servers. `E2E_BASE_URL=http://localhost:3000 npm run test:e2e` tests an already running Compose stack instead. `PLAYWRIGHT_CHROME_CHANNEL=chrome` uses an installed Chrome. Tests use real API responses; the connection-error test deliberately aborts requests, and the loading test delays forwarding a real request. No inventory responses are mocked.

Coverage includes failed stock adjustments with no writes, successful movements, multi-item rollback, server price authority, invalid inputs, history protections, integer limits, 24 concurrent orders competing for 10 units, cancellation races, reversed item ordering, and a database-trigger failure after writes have already begun. Frontend tests cover pure validation/formatting and browser journeys through stock conflicts, order creation, cancellation, restored inventory, history, loading/empty/error/retry states, and a mobile viewport. CI runs backend tests, frontend tests/build, and browser tests with PostgreSQL.

See [docs/VERIFICATION.md](docs/VERIFICATION.md) for the actual local verification record and environment limits.

## Scope, time, and next steps

- The mandatory feature flows and full-stack Compose configuration are implemented. Bonuses included: all three services in Compose, `useDebounce`, skeletons, and concurrency/race tests.
- Deferred: order idempotency keys, daily sales reports, authentication/authorization, paginated movement history, inventory costing, richer audit identity, and production observability. A lost response after a committed sale requires checking the order list before retrying; idempotency keys are the next data-safety improvement.
- Production migration execution should use a dedicated deployment role; request credentials should have narrower permissions. Production schema changes would need a rollout strategy and backups.
- **Human hours spent:** not supplied and cannot be inferred from this AI session. No claim of 6–8 hours of independent work is made. Record actual human effort before any permitted submission.
- **Git history:** the repository had no commits when work began. Focused local commits group the API, frontend, and deployment/documentation work at the end of this implementation session. No commits are backdated and no day-long activity is claimed.

Repository layout:

```text
backend/
  cmd/api/                    # entry point, startup, graceful shutdown
  internal/api/               # HTTP contract, transactions, integration tests
  internal/database/          # embedded versioned migrations and seed
frontend/
  src/                        # UI, API client, shared types, pure logic tests
  e2e/                        # real-backend browser workflows
docker-compose.yml
.github/workflows/ci.yml
docs/
```
