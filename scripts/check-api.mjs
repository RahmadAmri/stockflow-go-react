import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// Probe the actual running server. Only one disposable, zero-stock product is
// created, edited, and deleted. Existing inventory and orders are never changed.
const base = process.env.API_BASE_URL ?? "http://127.0.0.1:5173";
const sku = `CHECK-${randomUUID().slice(0, 12)}`;
let productID;
let checks = 0;

async function check(method, path, expected, body, code) {
  const response = await fetch(new URL(path, base), {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const data = response.status === 204 ? null : await response.json();
  assert.equal(
    response.status,
    expected,
    `${method} ${path}: expected ${expected}, got ${response.status}: ${JSON.stringify(data)}`,
  );
  if (code)
    assert.equal(data.error?.code, code, `${method} ${path}: wrong error code`);
  checks++;
  console.log(`PASS ${method} ${path} → ${expected}`);
  return data;
}

try {
  assert.equal((await check("GET", "/api/health", 200)).status, "ok");
  const catalog = await check("GET", "/api/products?page=1&limit=10", 200);
  assert(Array.isArray(catalog.data));
  assert.equal(catalog.page, 1);
  assert.equal(catalog.limit, 10);
  for (const product of catalog.data) {
    assert(Number.isInteger(product.price) && product.price >= 0);
    assert(Number.isInteger(product.stock) && product.stock >= 0);
    assert(
      product.last_movement_at === null ||
        !Number.isNaN(Date.parse(product.last_movement_at)),
    );
  }
  const summary = await check("GET", "/api/summary", 200);
  assert(
    Number.isInteger(summary.total_products) && summary.total_products >= 0,
  );
  assert(
    Number.isInteger(summary.active_products) &&
      summary.active_products <= summary.total_products,
  );
  assert.match(summary.total_stock_value, /^\d+$/);
  const orders = await check("GET", "/api/orders?page=1&limit=10", 200);
  assert(Array.isArray(orders.data));
  if (orders.data.length) {
    const order = await check("GET", `/api/orders/${orders.data[0].id}`, 200);
    assert.equal(
      order.total,
      order.items.reduce((sum, item) => sum + item.qty * item.unit_price, 0),
    );
  }

  const input = {
    sku,
    name: "Disposable API connection check",
    price: 1000,
    is_active: true,
  };
  const created = await check("POST", "/api/products", 201, input);
  productID = created.id;
  assert.equal(created.stock, 0);
  assert.equal(created.last_movement_at, null);
  await check("POST", "/api/products", 409, input, "SKU_EXISTS");
  await check(
    "POST",
    "/api/products",
    400,
    { sku: `${sku}-BAD`, name: "Invalid", price: -1 },
    "VALIDATION_ERROR",
  );
  const updated = await check("PUT", `/api/products/${productID}`, 200, {
    ...input,
    name: "Updated API connection check",
    price: 2000,
  });
  assert.equal(updated.price, 2000);
  const inactive = await check(
    "PATCH",
    `/api/products/${productID}/status`,
    200,
    { is_active: false },
  );
  assert.equal(inactive.is_active, false);
  assert.equal(inactive.name, updated.name);
  assert.equal(inactive.price, 2000);
  const filtered = await check(
    "GET",
    `/api/products?search=${sku.toLowerCase()}&filter=inactive&page=1&limit=10`,
    200,
  );
  assert.equal(filtered.total, 1);
  assert.equal(filtered.data[0].id, productID);
  await check("PATCH", `/api/products/${productID}/status`, 200, {
    is_active: true,
  });
  await check(
    "POST",
    `/api/products/${productID}/stock`,
    400,
    { type: "in", qty: 0 },
    "VALIDATION_ERROR",
  );
  const overdraw = await check(
    "POST",
    `/api/products/${productID}/stock`,
    409,
    { type: "out", qty: 1 },
    "INSUFFICIENT_STOCK",
  );
  assert.equal(overdraw.error.available, 0);

  await check(
    "POST",
    "/api/orders",
    400,
    { customer: "API connection check", items: [] },
    "VALIDATION_ERROR",
  );
  await check(
    "POST",
    "/api/orders",
    400,
    { customer: "API connection check", items: [{ sku, qty: 0 }] },
    "VALIDATION_ERROR",
  );
  await check(
    "POST",
    "/api/orders",
    400,
    {
      customer: "API connection check",
      items: [
        { sku, qty: 1 },
        { sku, qty: 1 },
      ],
    },
    "VALIDATION_ERROR",
  );
  await check(
    "POST",
    "/api/orders",
    400,
    {
      customer: "API connection check",
      items: [{ sku: `${sku}-MISSING`, qty: 1 }],
    },
    "VALIDATION_ERROR",
  );
  const insufficient = await check(
    "POST",
    "/api/orders",
    409,
    { customer: "API connection check", items: [{ sku, qty: 1 }] },
    "INSUFFICIENT_STOCK",
  );
  assert.equal(insufficient.error.sku, sku);
  assert.equal(insufficient.error.available, 0);
  // An invalid order ID checks route dispatch without cancelling anyone's sale.
  await check(
    "POST",
    "/api/orders/not-an-id/cancel",
    400,
    undefined,
    "VALIDATION_ERROR",
  );
  const movements = await check(
    "GET",
    `/api/products/${productID}/movements`,
    200,
  );
  assert.deepEqual(movements.data, []);
  await check("DELETE", `/api/products/${productID}`, 204);
  await check("PUT", `/api/products/${productID}`, 404, input, "NOT_FOUND");
  await check(
    "PATCH",
    `/api/products/${productID}/status`,
    404,
    { is_active: false },
    "NOT_FOUND",
  );
  await check(
    "GET",
    `/api/products/${productID}/movements`,
    404,
    undefined,
    "NOT_FOUND",
  );
  await check(
    "DELETE",
    `/api/products/${productID}`,
    404,
    undefined,
    "NOT_FOUND",
  );
  productID = undefined;
  console.log(
    `\nAll ${checks} live checks passed through ${base}. Temporary product removed.`,
  );
  console.log(
    "Successful stock/order/cancellation transactions and history protection are covered by the isolated database and browser suites.",
  );
} catch (error) {
  console.error(`\nAPI check failed: ${error.message}`);
  console.error(
    "Check that the running API matches this checkout. Use npm run dev for automatic Go reloads.",
  );
  process.exitCode = 1;
} finally {
  if (productID !== undefined) {
    try {
      const response = await fetch(
        new URL(`/api/products/${productID}`, base),
        { method: "DELETE", signal: AbortSignal.timeout(5000) },
      );
      if (![204, 404].includes(response.status)) {
        console.error(
          `Temporary product ${sku} could not be removed (HTTP ${response.status}); history was not altered.`,
        );
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(`Cleanup for ${sku} failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
