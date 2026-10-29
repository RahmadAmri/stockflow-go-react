# StockFlow frontend

See the [root README](../README.md) for API/database setup, Docker, design decisions, and tests.

```sh
npm ci
npm run dev       # proxies /api to the Go backend on port 8080
npm test
npm run build
npm run test:e2e  # needs PostgreSQL + Go, or E2E_BASE_URL for a running stack
```

`src/types.ts` defines shared API types. `src/api.ts` is the sole fetch boundary. The frontend contains no mock inventory or order data.
