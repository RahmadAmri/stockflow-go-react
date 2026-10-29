import { useCallback, useState } from "react";
import type { FormEvent } from "react";
import { api, ApiError } from "./api";
import { ErrorMessage, Icon, Modal, Pagination } from "./components";
import { useDebounce, useResource } from "./hooks";
import { dateTime, isQuantity, rupiah, validateOrder } from "./logic";
import type { Order, Product } from "./types";

type DraftItem = { key: number; product: Product | null; qty: string };
function ProductPicker({
  value,
  onChange,
  disabled,
  label,
}: {
  value: Product | null;
  onChange: (value: Product) => void;
  disabled: boolean;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const debounced = useDebounce(search);
  const load = useCallback(
    (signal: AbortSignal) =>
      api.products(debounced, "active", page, 10, signal),
    [debounced, page],
  );
  const resource = useResource(load);
  return (
    <div className="product-picker">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        className="picker-trigger"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        {value ? `${value.sku} · ${value.name}` : "Choose a product…"}
        <span>⌄</span>
      </button>
      {open && (
        <div className="picker-panel">
          <label className="search-field">
            <Icon name="search" size={16} />
            <input
              aria-label="Search products for order"
              autoFocus
              placeholder="Search SKU or name"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </label>
          {resource.loading ? (
            <p role="status">Loading products…</p>
          ) : resource.error ? (
            <>
              <ErrorMessage error={resource.error} />
              <button type="button" onClick={resource.retry}>
                Retry
              </button>
            </>
          ) : (
            <>
              {resource.data?.data.map((p) => (
                <button
                  type="button"
                  className="picker-option"
                  key={p.id}
                  onClick={() => {
                    onChange(p);
                    setOpen(false);
                  }}
                >
                  <span>
                    <strong>{p.sku}</strong> · {p.name}
                  </span>
                  <small>
                    {p.stock} available · {rupiah(p.price)}
                  </small>
                </button>
              ))}
              {resource.data?.total === 0 && <p>No active products found.</p>}
              {resource.data && resource.data.total > 10 && (
                <Pagination
                  page={page}
                  total={resource.data.total}
                  onChange={setPage}
                />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
export function CreateOrderDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (order: Order) => void;
}) {
  const [customer, setCustomer] = useState("");
  const [items, setItems] = useState<DraftItem[]>([
    { key: 0, product: null, qty: "1" },
  ]);
  const [nextKey, setNextKey] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const failedSKU = error instanceof ApiError ? error.detail.sku : undefined;
  function change(key: number, patch: Partial<DraftItem>) {
    setItems((rows) =>
      rows.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    );
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    const body = {
      customer: customer.trim(),
      items: items.map((item) => ({
        sku: item.product?.sku ?? "",
        qty: isQuantity(item.qty) ? Number(item.qty) : NaN,
      })),
    };
    const issue = validateOrder(body);
    if (issue) {
      setError(issue);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onCreated(await api.createOrder(body));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  const estimate = items.reduce(
    (sum, item) =>
      sum +
      (item.product?.price ?? 0) *
        (isQuantity(item.qty) ? Number(item.qty) : 0),
    0,
  );
  return (
    <Modal
      title="Create sales order"
      subtitle="Choose your products. Stock is reserved when the order is created."
      onClose={onClose}
      busy={busy}
      wide
    >
      <form onSubmit={submit} noValidate>
        <div className="form-body">
          <ErrorMessage error={error} />
          <label>
            Customer name
            <input
              autoFocus
              value={customer}
              onChange={(e) => setCustomer(e.target.value)}
              maxLength={200}
              placeholder="e.g. Kedai Senja"
              disabled={busy}
              required
            />
          </label>
          <div className="section-label">Order items</div>
          {items.map((item, index) => (
            <div
              key={item.key}
              className={`order-draft-row ${item.product?.sku === failedSKU ? "failed-item" : ""}`}
            >
              <div className="draft-product">
                <label>Product {index + 1}</label>
                <ProductPicker
                  label={`Choose product ${index + 1}`}
                  value={item.product}
                  onChange={(product) => change(item.key, { product })}
                  disabled={busy}
                />
                {item.product && (
                  <small>
                    {item.product.stock} units available ·{" "}
                    {rupiah(item.product.price)} each
                  </small>
                )}
              </div>
              <label className="quantity-field">
                Quantity
                <input
                  aria-label={`Quantity for item ${index + 1}`}
                  type="number"
                  min="1"
                  step="1"
                  value={item.qty}
                  onChange={(e) => change(item.key, { qty: e.target.value })}
                  disabled={busy}
                />
              </label>
              <button
                type="button"
                className="icon-button remove-item"
                aria-label={`Remove item ${index + 1}`}
                disabled={busy || items.length === 1}
                onClick={() =>
                  setItems((rows) => rows.filter((row) => row.key !== item.key))
                }
              >
                <Icon name="trash" size={17} />
              </button>
              {item.product?.sku === failedSKU && (
                <p className="item-error">
                  {error instanceof ApiError &&
                  error.detail.available !== undefined
                    ? `Only ${error.detail.available} units available for ${failedSKU}.`
                    : `Check ${failedSKU}: ${error instanceof Error ? error.message : "Invalid item"}`}
                </p>
              )}
            </div>
          ))}
          <button
            type="button"
            className="button secondary small"
            disabled={busy || items.length >= 100}
            onClick={() => {
              setItems((rows) => [
                ...rows,
                { key: nextKey, product: null, qty: "1" },
              ]);
              setNextKey((v) => v + 1);
            }}
          >
            <Icon name="plus" size={16} />
            Add item
          </button>
          <div className="order-total">
            <div>
              <span>Estimated total</span>
              <small>Final prices and total are confirmed by the server.</small>
            </div>
            <strong>
              {Number.isSafeInteger(estimate)
                ? rupiah(estimate)
                : "Exceeds order limit"}
            </strong>
          </div>
        </div>
        <footer className="modal-footer">
          <button
            type="button"
            className="button secondary"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? "Creating…" : "Create order"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
export function OrderDetailDialog({
  id,
  onClose,
  onChanged,
}: {
  id: number;
  onClose: () => void;
  onChanged: (message: string) => void;
}) {
  const load = useCallback(
    (signal: AbortSignal) => api.order(id, signal),
    [id],
  );
  const resource = useResource(load);
  const [updated, setUpdated] = useState<Order | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const order = updated ?? resource.data;
  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      setUpdated(await api.cancelOrder(id));
      setConfirm(false);
      onChanged("Order cancelled. All stock has been restored.");
    } catch (e) {
      setError(e);
      resource.retry();
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`Order #${String(id).padStart(4, "0")}`}
      subtitle="Sales order details"
      onClose={onClose}
      busy={busy}
      wide
    >
      <div className="form-body">
        {resource.loading && !order ? (
          <p role="status">Loading order…</p>
        ) : resource.error ? (
          <>
            <ErrorMessage error={resource.error} />
            <button className="button secondary" onClick={resource.retry}>
              Retry
            </button>
          </>
        ) : (
          order && (
            <>
              <div className="order-meta">
                <div>
                  <small>Customer</small>
                  <h3>{order.customer}</h3>
                  <p>{dateTime(order.created_at)}</p>
                </div>
                <span
                  className={`badge ${order.status === "CREATED" ? "active" : "inactive"}`}
                >
                  {order.status === "CREATED" ? "Created" : "Cancelled"}
                </span>
              </div>
              <div className="table-scroll">
                <table className="detail-table">
                  <thead>
                    <tr>
                      <th>SKU</th>
                      <th>Quantity</th>
                      <th>Unit price</th>
                      <th className="align-right">Subtotal</th>
                    </tr>
                  </thead>
                  <tbody>
                    {order.items.map((item) => (
                      <tr key={item.sku}>
                        <td className="sku">{item.sku}</td>
                        <td>{item.qty}</td>
                        <td>{rupiah(item.unit_price)}</td>
                        <td className="align-right">
                          {rupiah(item.unit_price * item.qty)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="order-total">
                <span>Total</span>
                <strong>{rupiah(order.total)}</strong>
              </div>
              {order.cancelled_at && (
                <div className="success-note">
                  <Icon name="check" />
                  Stock restored · {dateTime(order.cancelled_at)}
                </div>
              )}
              <ErrorMessage error={error} />
              {confirm && (
                <div className="confirmation">
                  <strong>Cancel this order?</strong>
                  <p>
                    All {order.items.length} item types will be returned to
                    inventory. This cannot be undone.
                  </p>
                  <div className="button-group">
                    <button
                      className="button secondary small"
                      onClick={() => setConfirm(false)}
                      disabled={busy}
                    >
                      Keep order
                    </button>
                    <button
                      className="button danger small"
                      onClick={cancel}
                      disabled={busy}
                    >
                      {busy ? "Cancelling…" : "Confirm cancellation"}
                    </button>
                  </div>
                </div>
              )}
            </>
          )
        )}
      </div>
      <footer className="modal-footer split">
        <div>
          {order?.status === "CREATED" && !confirm && (
            <button
              className="button danger-outline"
              onClick={() => setConfirm(true)}
            >
              Cancel order
            </button>
          )}
        </div>
        <button className="button secondary" onClick={onClose} disabled={busy}>
          Done
        </button>
      </footer>
    </Modal>
  );
}
