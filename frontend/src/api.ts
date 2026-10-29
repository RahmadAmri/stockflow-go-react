import type {
  ErrorDetail,
  Movement,
  Order,
  OrderInput,
  OrderSummary,
  Page,
  Product,
  ProductFilter,
  ProductInput,
  StockInput,
  Summary,
} from "./types";

export class ApiError extends Error {
  readonly detail: ErrorDetail;
  readonly status: number;
  constructor(status: number, detail: ErrorDetail) {
    super(detail.message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function parseError(value: unknown, status: number): ErrorDetail {
  if (isRecord(value) && isRecord(value.error)) {
    const e = value.error;
    const fields: Record<string, string> = {};
    if (isRecord(e.fields))
      for (const [key, v] of Object.entries(e.fields))
        if (typeof v === "string") fields[key] = v;
    return {
      code: typeof e.code === "string" ? e.code : "REQUEST_FAILED",
      message:
        typeof e.message === "string"
          ? e.message
          : `Request failed (${status})`,
      sku: typeof e.sku === "string" ? e.sku : undefined,
      available: typeof e.available === "number" ? e.available : undefined,
      fields,
    };
  }
  return {
    code: "REQUEST_FAILED",
    message: `The server could not complete this request (${status}). Please retry.`,
  };
}
// This is the only fetch boundary in the app. All requests use the same origin;
// Vite and nginx forward /api to Go in development and Docker respectively.
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      throw error;
    throw new ApiError(0, {
      code: "NETWORK_ERROR",
      message: "Cannot reach StockFlow. Check your connection and try again.",
    });
  }
  if (response.status === 204) return undefined as T;
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiError(response.status, parseError(body, response.status));
  if (body === null)
    throw new ApiError(response.status, {
      code: "INVALID_RESPONSE",
      message: "The server returned an invalid response.",
    });
  return body as T;
}
export const api = {
  products: (
    search = "",
    filter: ProductFilter = "all",
    page = 1,
    limit = 10,
    signal?: AbortSignal,
  ) =>
    request<Page<Product>>(
      `/products?${new URLSearchParams({ search, filter, page: String(page), limit: String(limit) })}`,
      { signal },
    ),
  summary: (signal?: AbortSignal) => request<Summary>("/summary", { signal }),
  createProduct: (body: ProductInput) =>
    request<Product>("/products", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateProduct: (id: number, body: ProductInput) =>
    request<Product>(`/products/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  deleteProduct: (id: number) =>
    request<void>(`/products/${id}`, { method: "DELETE" }),
  setProductStatus: (id: number, isActive: boolean) =>
    request<Product>(`/products/${id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ is_active: isActive }),
    }),
  adjustStock: (id: number, body: StockInput) =>
    request<Product>(`/products/${id}/stock`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  movements: (id: number, signal?: AbortSignal) =>
    request<{ data: Movement[] }>(`/products/${id}/movements`, { signal }),
  orders: (page = 1, signal?: AbortSignal) =>
    request<Page<OrderSummary>>(
      `/orders?${new URLSearchParams({ page: String(page), limit: "10" })}`,
      { signal },
    ),
  order: (id: number, signal?: AbortSignal) =>
    request<Order>(`/orders/${id}`, { signal }),
  createOrder: (body: OrderInput) =>
    request<Order>("/orders", { method: "POST", body: JSON.stringify(body) }),
  cancelOrder: (id: number) =>
    request<Order>(`/orders/${id}/cancel`, { method: "POST" }),
};
