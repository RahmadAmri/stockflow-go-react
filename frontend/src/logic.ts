import type { OrderInput, ProductInput } from "./types";

export const MAX_INTEGER = 2_147_483_647;
export function isQuantity(value: string): boolean {
  return (
    /^\d+$/.test(value) &&
    Number.isSafeInteger(Number(value)) &&
    Number(value) > 0 &&
    Number(value) <= MAX_INTEGER
  );
}
export function validateProduct(value: ProductInput): string | null {
  if (!value.sku.trim() || [...value.sku.trim()].length > 64)
    return "Enter a SKU of 1–64 characters.";
  if (!value.name.trim() || [...value.name.trim()].length > 200)
    return "Enter a name of 1–200 characters.";
  if (
    !Number.isInteger(value.price) ||
    value.price < 0 ||
    value.price > MAX_INTEGER
  )
    return "Price must be a whole number from 0 to 2.147.483.647.";
  return null;
}
export function validateOrder(value: OrderInput): string | null {
  if (!value.customer.trim() || [...value.customer.trim()].length > 200)
    return "Enter a customer name of 1–200 characters.";
  if (value.items.length < 1 || value.items.length > 100)
    return "Add between 1 and 100 items.";
  const skus = new Set<string>();
  for (const item of value.items) {
    const sku = item.sku.trim();
    if (!sku) return "Choose a product for every item.";
    if (!Number.isInteger(item.qty) || item.qty <= 0 || item.qty > MAX_INTEGER)
      return `Enter a positive whole quantity for ${sku}.`;
    if (skus.has(sku))
      return `Duplicate SKU: ${sku}. Combine its quantities into one line.`;
    skus.add(sku);
  }
  return null;
}
const numberFormat = new Intl.NumberFormat("id-ID", {
  maximumFractionDigits: 0,
});
export const rupiah = (value: number | string): string =>
  `Rp ${numberFormat.format(typeof value === "string" ? BigInt(value) : value)}`;
export const count = (value: number): string => numberFormat.format(value);
export function relativeTime(value: string | null, now = Date.now()): string {
  if (!value) return "No movement";
  const seconds = Math.max(
    0,
    Math.floor((now - new Date(value).getTime()) / 1000),
  );
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
export const dateTime = (value: string): string =>
  new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
