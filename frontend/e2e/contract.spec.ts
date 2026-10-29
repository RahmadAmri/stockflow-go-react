import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page as BrowserPage } from "@playwright/test";
import type { Page, Product, Summary } from "../src/types.ts";
import { count, rupiah } from "../src/logic.ts";

async function createProduct(
  request: APIRequestContext,
  sku: string,
  price: number,
  stock: number,
) {
  const response = await request.post("/api/products", {
    data: { sku, name: `Contract test ${sku}`, price, is_active: true },
  });
  expect(response.status()).toBe(201);
  const product: Product = await response.json();
  if (stock > 0) {
    expect(
      (
        await request.post(`/api/products/${product.id}/stock`, {
          data: { type: "in", qty: stock },
        })
      ).status(),
    ).toBe(200);
  }
  return product;
}

async function chooseProduct(page: BrowserPage, index: number, sku: string) {
  await page.getByRole("button", { name: `Choose product ${index}` }).click();
  await page.getByLabel("Search products for order").fill(sku);
  await page.locator(".picker-option").filter({ hasText: sku }).click();
}

async function productStock(request: APIRequestContext, sku: string) {
  const response = await request.get("/api/products", {
    params: { search: sku },
  });
  expect(response.status()).toBe(200);
  const products: Page<Product> = await response.json();
  return products.data.find((product) => product.sku === sku)?.stock;
}

async function expectSummary(page: BrowserPage, request: APIRequestContext) {
  const response = await request.get("/api/summary");
  expect(response.status()).toBe(200);
  const summary: Summary = await response.json();
  const values = [
    count(summary.total_products),
    count(summary.active_products),
    rupiah(summary.total_stock_value),
    count(summary.low_stock_count),
  ];
  for (const [index, value] of values.entries()) {
    await expect(page.locator(".summary-card > strong").nth(index)).toHaveText(
      value,
    );
  }
  return summary;
}

test("multi-item order uses server prices, identifies the failing SKU, and restores all stock", async ({
  page,
  request,
}) => {
  const prefix = `MULTI-${Date.now()}`;
  const a = await createProduct(request, `${prefix}-A`, 1000, 12);
  const b = await createProduct(request, `${prefix}-B`, 2000, 2);
  await page.goto("/");
  const before = await expectSummary(page, request);
  await page.getByRole("button", { name: "Create order", exact: true }).click();
  await page.getByLabel("Customer name").fill("Multi-item browser cafe");
  await chooseProduct(page, 1, a.sku);
  await page.getByLabel("Quantity for item 1").fill("3");
  await page.getByRole("button", { name: "Add item", exact: true }).click();
  await chooseProduct(page, 2, b.sku);
  await page.getByLabel("Quantity for item 2").fill("3");
  const submit = page
    .getByRole("dialog")
    .getByRole("button", { name: "Create order", exact: true });
  await submit.click();
  await expect(page.locator(".failed-item")).toHaveCount(1);
  await expect(page.locator(".failed-item")).toContainText(
    `Only 2 units available for ${b.sku}`,
  );
  expect(await productStock(request, a.sku)).toBe(12);
  expect(await productStock(request, b.sku)).toBe(2);
  await expectSummary(page, request);

  // The picker still shows the old estimate, but the server must use the new price.
  expect(
    (
      await request.put(`/api/products/${a.id}`, {
        data: { sku: a.sku, name: a.name, price: 1500, is_active: true },
      })
    ).status(),
  ).toBe(200);
  await page.getByLabel("Quantity for item 2").fill("2");
  await submit.click();
  await expect(
    page.getByRole("dialog").getByRole("heading", { name: /^Order #/ }),
  ).toBeVisible();
  await expect(page.getByRole("dialog").locator(".order-total")).toContainText(
    "Rp 8.500",
  );
  await expect(
    page.getByRole("dialog").getByRole("row").filter({ hasText: a.sku }),
  ).toContainText("Rp 1.500");
  expect(await productStock(request, a.sku)).toBe(9);
  expect(await productStock(request, b.sku)).toBe(0);
  const after = await expectSummary(page, request);
  expect(BigInt(after.total_stock_value)).toBe(
    BigInt(before.total_stock_value) + 6000n - 8500n,
  );
  expect(after.low_stock_count).toBe(before.low_stock_count + 1);

  await page.getByRole("button", { name: "Cancel order", exact: true }).click();
  await page
    .getByRole("button", { name: "Confirm cancellation", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("Stock restored");
  expect(await productStock(request, a.sku)).toBe(12);
  expect(await productStock(request, b.sku)).toBe(2);
  const restored = await expectSummary(page, request);
  expect(BigInt(restored.total_stock_value)).toBe(
    BigInt(before.total_stock_value) + 6000n,
  );
  expect(restored.low_stock_count).toBe(before.low_stock_count);
});

test("a real server 400 is visible when a selected product becomes inactive", async ({
  page,
  request,
}) => {
  const product = await createProduct(
    request,
    `INACTIVE-${Date.now()}`,
    1000,
    4,
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Create order", exact: true }).click();
  await page.getByLabel("Customer name").fill("Validation browser cafe");
  await chooseProduct(page, 1, product.sku);
  expect(
    (
      await request.patch(`/api/products/${product.id}/status`, {
        data: { is_active: false },
      })
    ).status(),
  ).toBe(200);
  const rejected = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/orders") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create order", exact: true })
    .click();
  expect((await rejected).status()).toBe(400);
  await expect(page.getByRole("alert")).toContainText(
    `Product is inactive: ${product.sku}`,
  );
  await expect(page.locator(".failed-item")).toContainText(product.sku);
  expect(await productStock(request, product.sku)).toBe(4);
});

test("pagination and filters keep global summary totals and refresh after mutations", async ({
  page,
  request,
}) => {
  const prefix = `FILTER-${Date.now()}`;
  const products: Product[] = [];
  for (let i = 0; i < 12; i++) {
    products.push(
      await createProduct(
        request,
        `${prefix}-${String(i).padStart(2, "0")}`,
        1000,
        0,
      ),
    );
  }
  await page.goto("/");
  await page
    .getByLabel("Search products", { exact: true })
    .fill(prefix.toLowerCase());
  await expect(page.locator(".products-table tbody tr")).toHaveCount(10);
  await expect(page.locator(".pagination")).toContainText("1–10 of 12 results");
  const before = await expectSummary(page, request);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.locator(".products-table tbody tr")).toHaveCount(2);
  await expect(page.locator(".pagination")).toContainText(
    "11–12 of 12 results",
  );

  // Deleting the last row on a page refreshes both total products and active count.
  await page
    .getByRole("button", { name: `Delete ${products[11].sku}`, exact: true })
    .click();
  await page
    .getByRole("button", { name: "Delete product", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.locator(".products-table tbody tr")).toHaveCount(1);
  const afterDelete = await expectSummary(page, request);
  expect(afterDelete.total_products).toBe(before.total_products - 1);
  expect(afterDelete.active_products).toBe(before.active_products - 1);
  expect(afterDelete.low_stock_count).toBe(before.low_stock_count - 1);

  await page.getByRole("button", { name: "Low stock", exact: true }).click();
  await expect(page.locator(".pagination")).toContainText("1–10 of 11 results");
  await page
    .getByRole("button", { name: `Adjust stock for ${products[0].sku}` })
    .click();
  await page.getByLabel("Quantity", { exact: true }).fill("11");
  await page.getByRole("button", { name: "Save adjustment" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.locator(".pagination")).toContainText("1–10 of 10 results");
  await expect(
    page.getByRole("row").filter({ hasText: products[0].sku }),
  ).toHaveCount(0);
  const afterStock = await expectSummary(page, request);
  expect(BigInt(afterStock.total_stock_value)).toBe(
    BigInt(afterDelete.total_stock_value) + 11000n,
  );
  expect(afterStock.low_stock_count).toBe(afterDelete.low_stock_count - 1);

  await page.getByRole("button", { name: "All products", exact: true }).click();
  await page
    .getByRole("button", { name: `Delete ${products[0].sku}`, exact: true })
    .click();
  await page
    .getByRole("button", { name: "Deactivate product", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const afterDeactivate = await expectSummary(page, request);
  expect(afterDeactivate.active_products).toBe(afterStock.active_products - 1);
  expect(afterDeactivate.total_stock_value).toBe(afterStock.total_stock_value);
  await page.getByRole("button", { name: "Active", exact: true }).click();
  await expect(page.locator(".pagination")).toContainText("1–10 of 10 results");
  await page.getByRole("button", { name: "Inactive", exact: true }).click();
  await expect(page.locator(".products-table tbody tr")).toHaveCount(1);
  await expect(page.locator(".products-table tbody")).toContainText(
    products[0].sku,
  );
  await expectSummary(page, request);
});
