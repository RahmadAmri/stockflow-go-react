import { expect, test } from "@playwright/test";

test("real API: products, stock conflict, sale, cancellation, and immutable history", async ({
  page,
}) => {
  const sku = `E2E-${Date.now()}`;
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Products", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add product", exact: true }).click();
  await page.getByLabel("SKU", { exact: true }).fill(sku);
  await page
    .getByLabel("Product name", { exact: true })
    .fill("Browser test coffee");
  await page.getByLabel("Price (IDR)").fill("85000");
  await page.getByRole("button", { name: "Save product" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByLabel("Search products", { exact: true }).fill(sku);
  const row = page.getByRole("row").filter({ hasText: sku });
  await expect(row).toBeVisible();
  await expect(row).toContainText("No movement");
  await page.getByRole("button", { name: `Adjust stock for ${sku}` }).click();
  await page.getByLabel("Quantity", { exact: true }).fill("8");
  await page.getByRole("button", { name: "Save adjustment" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(row.locator(".stock-count")).toHaveText("8");
  await page.getByRole("button", { name: `Adjust stock for ${sku}` }).click();
  await page.getByRole("radio", { name: "Stock out" }).check();
  await page.getByLabel("Quantity", { exact: true }).fill("9");
  await page.getByRole("button", { name: "Save adjustment" }).click();
  await expect(page.getByRole("alert")).toContainText("8 units available");
  await page.getByRole("button", { name: "Close dialog" }).click();

  await page.getByRole("button", { name: "Create order", exact: true }).click();
  await page.getByLabel("Customer name").fill("Browser test cafe");
  await page.getByRole("button", { name: "Choose product 1" }).click();
  await page.getByLabel("Search products for order").fill(sku);
  await page
    .getByRole("button")
    .filter({ hasText: `${sku} · Browser test coffee` })
    .click();
  await page.getByLabel("Quantity for item 1").fill("9");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create order", exact: true })
    .click();
  await expect(page.locator(".failed-item")).toContainText(
    `Only 8 units available for ${sku}`,
  );
  await page.getByLabel("Quantity for item 1").fill("3");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create order", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").getByRole("heading", { name: /^Order #/ }),
  ).toBeVisible();
  await expect(page.getByRole("dialog").locator(".order-total")).toContainText(
    "Rp 255.000",
  );
  await expect(row.locator(".stock-count")).toHaveText("5");
  await page.getByRole("button", { name: "Cancel order", exact: true }).click();
  await page.getByRole("button", { name: "Confirm cancellation" }).click();
  await expect(page.getByRole("dialog")).toContainText("Stock restored");
  await expect(row.locator(".stock-count")).toHaveText("8");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: `History for ${sku}` }).click();
  await expect(page.locator(".history-row")).toHaveCount(3);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page
    .getByRole("button", { name: `Delete ${sku}`, exact: true })
    .click();
  await page
    .getByRole("button", { name: "Delete product", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("has history");
  await page.getByRole("button", { name: "Keep product" }).click();
  await page.getByRole("button", { name: `Edit ${sku}`, exact: true }).click();
  await page.getByLabel("Active and available for orders").uncheck();
  await page.getByRole("button", { name: "Save product" }).click();
  await expect(row).toContainText("Inactive");
  await page.getByRole("button", { name: "Inactive", exact: true }).click();
  await expect(row).toBeVisible();
});

test("loading, empty, and connection error states with retry", async ({
  page,
}) => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/products?**", async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto("/");
  await expect(
    page.getByRole("rowgroup", { name: "Loading results" }),
  ).toBeVisible();
  release?.();
  await page.unrouteAll({ behavior: "wait" });
  await page
    .getByLabel("Search products", { exact: true })
    .fill("NO-SUCH-SKU-987654321");
  await expect(
    page.getByRole("heading", { name: "No products found" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(
    page.getByRole("rowgroup", { name: "Loading results" }),
  ).not.toBeVisible();
  await page.route("**/api/products?**", (route) => route.abort());
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Cannot reach StockFlow");
  await page.unroute("**/api/products?**");
  await page.getByRole("button", { name: "Retry products" }).click();
  await expect(page.getByRole("alert")).not.toBeVisible();
  await expect(page.getByRole("table")).toBeVisible();
});

test("sales list and narrow-screen layout", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#orders");
  await expect(
    page.getByRole("heading", { name: "Sales orders", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "View order" }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog").locator(".order-total")).toBeVisible();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
