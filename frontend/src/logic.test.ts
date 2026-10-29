import { describe, expect, it } from "vitest";
import {
  isQuantity,
  relativeTime,
  rupiah,
  validateOrder,
  validateProduct,
} from "./logic";

describe("stock quantity validation", () => {
  it.each(["", "0", "-1", "1.5", "NaN", "Infinity", "1e2", "2147483648", " "])(
    "rejects %j",
    (value) => expect(isQuantity(value)).toBe(false),
  );
  it.each(["1", "42", "2147483647"])("accepts %j", (value) =>
    expect(isQuantity(value)).toBe(true),
  );
});
describe("order validation", () => {
  it("requires a customer and items", () => {
    expect(
      validateOrder({ customer: " ", items: [{ sku: "A", qty: 1 }] }),
    ).toContain("customer");
    expect(validateOrder({ customer: "Cafe", items: [] })).toContain("items");
  });
  it("rejects duplicate SKUs after trimming", () => {
    expect(
      validateOrder({
        customer: "Cafe",
        items: [
          { sku: "A", qty: 1 },
          { sku: " A ", qty: 2 },
        ],
      }),
    ).toContain("Duplicate SKU: A");
  });
  it.each([0, -1, 1.5, NaN, Infinity, 2_147_483_648])(
    "rejects invalid quantity %s",
    (qty) => {
      expect(
        validateOrder({ customer: "Cafe", items: [{ sku: "A", qty }] }),
      ).toContain("quantity");
    },
  );
  it("accepts a valid multi-item order", () =>
    expect(
      validateOrder({
        customer: "Cafe",
        items: [
          { sku: "A", qty: 2 },
          { sku: "B", qty: 3 },
        ],
      }),
    ).toBeNull());
});
describe("product validation", () => {
  const valid = { sku: "A", name: "Coffee", price: 85000, is_active: true };
  it("allows free products", () =>
    expect(validateProduct({ ...valid, price: 0 })).toBeNull());
  it.each([-1, 1.5, NaN, 2_147_483_648])("rejects invalid money %s", (price) =>
    expect(validateProduct({ ...valid, price })).not.toBeNull(),
  );
  it("requires names and SKUs", () => {
    expect(validateProduct({ ...valid, sku: " " })).toContain("SKU");
    expect(validateProduct({ ...valid, name: " " })).toContain("name");
  });
});
describe("display logic", () => {
  it("formats whole rupiah, including exact large aggregate values", () => {
    expect(rupiah(1234567)).toBe("Rp 1.234.567");
    expect(rupiah("9007199254740993")).toBe("Rp 9.007.199.254.740.993");
  });
  it("handles missing, recent, and future timestamps", () => {
    const now = Date.parse("2026-10-29T09:00:00Z");
    expect(relativeTime(null, now)).toBe("No movement");
    expect(relativeTime("2026-10-29T07:00:00Z", now)).toBe("2h ago");
    expect(relativeTime("2026-10-29T10:00:00Z", now)).toBe("Just now");
  });
});
