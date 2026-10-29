import { useCallback, useState } from "react";
import type { FormEvent } from "react";
import { api, ApiError } from "./api";
import { EmptyState, ErrorMessage, Modal } from "./components";
import { useResource } from "./hooks";
import { dateTime, isQuantity, validateProduct } from "./logic";
import type { Product } from "./types";

type Props = {
  product: Product;
  onClose: () => void;
  onSaved: (message: string) => void;
};
export function ProductEditor({
  product,
  onClose,
  onSaved,
}: Omit<Props, "product"> & { product?: Product }) {
  const [sku, setSKU] = useState(product?.sku ?? "");
  const [name, setName] = useState(product?.name ?? "");
  const [price, setPrice] = useState(String(product?.price ?? ""));
  const [active, setActive] = useState(product?.is_active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const input = {
      sku: sku.trim(),
      name: name.trim(),
      price: price.trim() ? Number(price) : NaN,
      is_active: active,
    };
    const issue = validateProduct(input);
    if (issue) {
      setError(issue);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (product) await api.updateProduct(product.id, input);
      else await api.createProduct(input);
      onSaved(
        product
          ? "Product updated."
          : "Product created. Add inventory with Adjust stock.",
      );
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={product ? "Edit product" : "Add product"}
      subtitle="Keep your product catalog up to date."
      onClose={onClose}
      busy={busy}
    >
      <form onSubmit={submit} noValidate>
        <div className="form-body">
          <ErrorMessage error={error} />
          <div className="form-row">
            <label>
              SKU
              <input
                autoFocus
                value={sku}
                onChange={(e) => setSKU(e.target.value)}
                maxLength={64}
                placeholder="COF-003"
                required
                disabled={busy}
              />
            </label>
            <label>
              Price (IDR)
              <input
                type="number"
                min="0"
                step="1"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="85000"
                required
                disabled={busy}
              />
            </label>
          </div>
          <label>
            Product name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={200}
              placeholder="Arabika Coffee · 250 g"
              required
              disabled={busy}
            />
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
              disabled={busy}
            />
            Active and available for orders
          </label>
          <p className="field-hint">
            {product
              ? "A SKU with movement history cannot be changed."
              : "New products start with zero stock. Record inventory using Adjust stock."}
          </p>
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
            {busy ? "Saving…" : "Save product"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
export function StockDialog({ product, onClose, onSaved }: Props) {
  const [direction, setDirection] = useState<"in" | "out">("in");
  const [qty, setQty] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!isQuantity(qty)) {
      setError(
        "Quantity must be a positive whole number, up to 2.147.483.647.",
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.adjustStock(product.id, {
        type: direction,
        qty: Number(qty),
        note,
      });
      onSaved(`Stock updated for ${product.sku}.`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Adjust stock"
      subtitle={`${product.sku} · ${product.name}`}
      onClose={onClose}
      busy={busy}
    >
      <form onSubmit={submit} noValidate>
        <div className="form-body">
          <div className="stock-overview">
            <span>Current stock</span>
            <strong>
              {product.stock} <small>units</small>
            </strong>
          </div>
          <ErrorMessage error={error} />
          <fieldset className="direction">
            <legend>Direction</legend>
            <label className={direction === "in" ? "selected" : ""}>
              <input
                type="radio"
                name="direction"
                value="in"
                checked={direction === "in"}
                onChange={() => setDirection("in")}
                disabled={busy}
              />
              ＋ Stock in
            </label>
            <label className={direction === "out" ? "selected" : ""}>
              <input
                type="radio"
                name="direction"
                value="out"
                checked={direction === "out"}
                onChange={() => setDirection("out")}
                disabled={busy}
              />
              − Stock out
            </label>
          </fieldset>
          <label>
            Quantity
            <input
              autoFocus
              type="number"
              min="1"
              step="1"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              placeholder="Enter quantity"
              disabled={busy}
              required
            />
          </label>
          <label>
            Note <span className="optional">(optional)</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={1000}
              placeholder="e.g. Supplier delivery or damaged goods"
              rows={3}
              disabled={busy}
            />
          </label>
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
            {busy ? "Saving…" : "Save adjustment"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
export function HistoryDialog({ product, onClose }: Omit<Props, "onSaved">) {
  const load = useCallback(
    (signal: AbortSignal) => api.movements(product.id, signal),
    [product.id],
  );
  const resource = useResource(load);
  return (
    <Modal
      title="Stock movements"
      subtitle={`${product.sku} · ${product.name}`}
      onClose={onClose}
      wide
    >
      <div className="form-body">
        {resource.loading ? (
          <p role="status">Loading movement history…</p>
        ) : resource.error ? (
          <>
            <ErrorMessage error={resource.error} />
            <button className="button secondary" onClick={resource.retry}>
              Retry
            </button>
          </>
        ) : resource.data?.data.length === 0 ? (
          <EmptyState
            title="No movements yet"
            description="Stock adjustments and sales will appear here."
          />
        ) : (
          <div className="history-list">
            {resource.data?.data.map((m) => (
              <div className="history-row" key={m.id}>
                <span className={`movement-symbol ${m.type}`}>
                  {m.type === "in" ? "+" : "−"}
                </span>
                <div>
                  <strong>{m.type === "in" ? "Stock in" : "Stock out"}</strong>
                  <p>
                    {m.note || "No note"}
                    {m.order_id && !m.note.includes("#")
                      ? ` · Order #${m.order_id}`
                      : ""}
                  </p>
                  <time>{dateTime(m.created_at)}</time>
                </div>
                <strong>
                  {m.type === "in" ? "+" : "−"}
                  {m.qty}
                </strong>
              </div>
            ))}
          </div>
        )}
      </div>
      <footer className="modal-footer">
        <button className="button secondary" onClick={onClose}>
          Done
        </button>
      </footer>
    </Modal>
  );
}
export function DeleteDialog({ product, onClose, onSaved }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [hasHistory, setHasHistory] = useState(
    product.last_movement_at !== null,
  );
  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await api.deleteProduct(product.id);
      onSaved(`${product.sku} deleted.`);
    } catch (e) {
      // History may have been added after this product was loaded. The API
      // remains authoritative; offer deactivation without repeating a deletion
      // that is now known to be prohibited.
      if (e instanceof ApiError && e.detail.code === "PRODUCT_HAS_HISTORY") {
        setHasHistory(true);
      } else {
        setError(e);
      }
    } finally {
      setBusy(false);
    }
  }
  async function deactivate() {
    setBusy(true);
    setError(null);
    try {
      await api.setProductStatus(product.id, false);
      onSaved(`${product.sku} deactivated. Stock and history were preserved.`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={
        hasHistory
          ? product.is_active
            ? "Deactivate product?"
            : "Product history is protected"
          : "Delete product?"
      }
      onClose={onClose}
      busy={busy}
    >
      <div className="form-body">
        {hasHistory ? (
          <>
            <p>
              <strong>{product.name}</strong> ({product.sku}) has stock or sales
              history and cannot be permanently deleted.
            </p>
            <p>
              {product.is_active
                ? "Deactivate it to remove it from active products and prevent new sales orders. Its stock and history will be preserved."
                : "This product is already inactive and cannot be used in new sales orders. Its stock and history are preserved."}
            </p>
            <p className="field-hint">
              It remains visible under All products and Inactive.
            </p>
          </>
        ) : (
          <p>
            Permanently delete <strong>{product.name}</strong> ({product.sku})
            from the catalog? This action cannot be undone.
          </p>
        )}
        <ErrorMessage error={error} />
      </div>
      <footer className="modal-footer">
        <button className="button secondary" onClick={onClose} disabled={busy}>
          {hasHistory
            ? product.is_active
              ? "Keep active"
              : "Close"
            : "Keep product"}
        </button>
        {hasHistory ? (
          product.is_active && (
            <button
              className="button primary"
              onClick={deactivate}
              disabled={busy}
            >
              {busy ? "Deactivating…" : "Deactivate product"}
            </button>
          )
        ) : (
          <button className="button danger" onClick={remove} disabled={busy}>
            {busy ? "Deleting…" : "Delete product"}
          </button>
        )}
      </footer>
    </Modal>
  );
}
