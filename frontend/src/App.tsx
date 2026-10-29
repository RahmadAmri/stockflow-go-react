import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import {
  EmptyState,
  ErrorMessage,
  Icon,
  LoadingRows,
  Pagination,
} from "./components";
import { useDebounce, useResource } from "./hooks";
import { count, dateTime, relativeTime, rupiah } from "./logic";
import { CreateOrderDialog, OrderDetailDialog } from "./OrderDialogs";
import {
  DeleteDialog,
  HistoryDialog,
  ProductEditor,
  StockDialog,
} from "./ProductDialogs";
import type { Product, ProductFilter } from "./types";
import "./App.css";

type Dialog =
  | { type: "add" | "create-order" }
  | { type: "edit" | "stock" | "history" | "delete"; product: Product }
  | { type: "order"; id: number }
  | null;
const filters: { value: ProductFilter; label: string }[] = [
  { value: "all", label: "All products" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
  { value: "low", label: "Low stock" },
];

export default function App() {
  const [view, setView] = useState<"products" | "orders">(
    window.location.hash === "#orders" ? "orders" : "products",
  );
  const [dialog, setDialog] = useState<Dialog>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ProductFilter>("all");
  const [page, setPage] = useState(1);
  const [orderPage, setOrderPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [toast, setToast] = useState("");
  const [clock, setClock] = useState(Date.now());
  const debouncedSearch = useDebounce(search);
  const loadProducts = useCallback(
    (signal: AbortSignal) =>
      api.products(debouncedSearch, filter, page, 10, signal),
    [debouncedSearch, filter, page, revision],
  );
  const loadSummary = useCallback(
    (signal: AbortSignal) => api.summary(signal),
    [revision],
  );
  const loadOrders = useCallback(
    (signal: AbortSignal) => api.orders(orderPage, signal),
    [orderPage, revision],
  );
  const products = useResource(loadProducts);
  const summary = useResource(loadSummary);
  const orders = useResource(loadOrders);
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(""), 6000);
      return () => clearTimeout(timer);
    }
  }, [toast]);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (
      products.data &&
      !products.loading &&
      page > 1 &&
      products.data.data.length === 0
    )
      setPage(Math.max(1, Math.ceil(products.data.total / 10)));
  }, [products.data, products.loading, page]);
  useEffect(() => {
    const navigate = () =>
      setView(window.location.hash === "#orders" ? "orders" : "products");
    window.addEventListener("hashchange", navigate);
    return () => window.removeEventListener("hashchange", navigate);
  }, []);
  function changed(message: string) {
    setRevision((v) => v + 1);
    setToast(message);
  }
  function saved(message: string) {
    setDialog(null);
    changed(message);
  }
  function refresh() {
    setRevision((v) => v + 1);
  }
  const cards = [
    {
      title: "Total products",
      value: summary.data ? count(summary.data.total_products) : "—",
      note: "Products in your catalog",
      icon: "box" as const,
      tone: "blue",
    },
    {
      title: "Active products",
      value: summary.data ? count(summary.data.active_products) : "—",
      note: "Available for sales orders",
      icon: "check" as const,
      tone: "green",
    },
    {
      title: "Stock value",
      value: summary.data ? rupiah(summary.data.total_stock_value) : "—",
      note: "Current price × units on hand",
      icon: "orders" as const,
      tone: "purple",
    },
    {
      title: "Low stock",
      value: summary.data ? count(summary.data.low_stock_count) : "—",
      note: "Products with 10 units or fewer",
      icon: "alert" as const,
      tone: "amber",
    },
  ];
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#products" aria-label="StockFlow home">
          <span className="brand-symbol">
            <Icon name="box" size={25} />
          </span>
          <span>
            stock<span className="brand-light">flow</span>
            <small>INVENTORY & SALES</small>
          </span>
        </a>
        <div className="workspace">
          <span className="workspace-avatar">MW</span>
          <div>
            <strong>Main warehouse</strong>
            <small>StockFlow workspace</small>
          </div>
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav aria-label="Main navigation">
          <a
            href="#products"
            className={view === "products" ? "nav-item selected" : "nav-item"}
            aria-current={view === "products" ? "page" : undefined}
          >
            <Icon name="grid" />
            Products{summary.data && <span>{summary.data.total_products}</span>}
          </a>
          <a
            href="#orders"
            className={view === "orders" ? "nav-item selected" : "nav-item"}
            aria-current={view === "orders" ? "page" : undefined}
          >
            <Icon name="orders" />
            Sales orders
          </a>
        </nav>
        <div className="sidebar-tip">
          <span className="tip-symbol">
            <Icon name="box" />
          </span>
          <strong>A clear view of your stock.</strong>
          <p>Every adjustment and order keeps your inventory in sync.</p>
        </div>
        <div className="sidebar-footer">
          <span className="profile-avatar">WS</span>
          <div>
            <strong>Warehouse supervisor</strong>
            <small>Local workspace</small>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <span>/</span>{" "}
            <strong>{view === "products" ? "Products" : "Sales orders"}</strong>
          </div>
          <span className="topbar-label">
            <span className="warehouse-dot" />
            Main warehouse
          </span>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">YOUR INVENTORY, IN FOCUS</div>
              <h1>{view === "products" ? "Products" : "Sales orders"}</h1>
              <p>
                {view === "products"
                  ? "Manage your catalog, track stock, and keep things moving."
                  : "Create orders, track sales, and manage cancellations."}
              </p>
            </div>
            <div className="heading-actions">
              <button
                className="button secondary"
                onClick={() => setDialog({ type: "create-order" })}
              >
                <Icon name="orders" size={18} />
                Create order
              </button>
              {view === "products" && (
                <button
                  className="button primary"
                  onClick={() => setDialog({ type: "add" })}
                >
                  <Icon name="plus" size={18} />
                  Add product
                </button>
              )}
            </div>
          </div>
          <section className="summary-grid" aria-label="Inventory summary">
            {cards.map((card) => (
              <article className="summary-card" key={card.title}>
                <div className="card-label">
                  {card.title}
                  <span className={`card-icon ${card.tone}`}>
                    <Icon name={card.icon} size={18} />
                  </span>
                </div>
                <strong className={summary.loading ? "summary-loading" : ""}>
                  {summary.error ? "—" : card.value}
                </strong>
                <p>{card.note}</p>
              </article>
            ))}
          </section>
          {summary.error && (
            <div className="inline-retry">
              <ErrorMessage error={summary.error} />
              <button
                className="button secondary small"
                onClick={summary.retry}
              >
                Retry summary
              </button>
            </div>
          )}
          {view === "products" ? (
            <section className="panel" aria-label="Product catalog">
              <div className="panel-heading">
                <div>
                  <h2>
                    Product catalog{" "}
                    <span className="count-chip">
                      {products.data?.total ?? "—"}
                    </span>
                  </h2>
                  <p>Your products and their current inventory levels.</p>
                </div>
                <button className="button secondary small" onClick={refresh}>
                  <Icon name="history" size={16} />
                  Refresh
                </button>
              </div>
              <div className="catalog-toolbar">
                <div
                  className="filter-tabs"
                  role="group"
                  aria-label="Filter products"
                >
                  {filters.map((f) => (
                    <button
                      key={f.value}
                      className={filter === f.value ? "selected" : ""}
                      aria-pressed={filter === f.value}
                      onClick={() => {
                        setFilter(f.value);
                        setPage(1);
                      }}
                    >
                      {f.label}
                      {f.value === "low" && <span className="small-dot" />}
                    </button>
                  ))}
                </div>
                <label className="search-field">
                  <Icon name="search" size={18} />
                  <input
                    aria-label="Search products"
                    placeholder="Search SKU or product name…"
                    value={search}
                    onChange={(e) => {
                      setSearch(e.target.value);
                      setPage(1);
                    }}
                  />
                  {search && (
                    <button
                      className="icon-button"
                      aria-label="Clear search"
                      onClick={() => {
                        setSearch("");
                        setPage(1);
                      }}
                    >
                      <Icon name="close" size={14} />
                    </button>
                  )}
                </label>
              </div>
              {products.error ? (
                <div className="panel-state">
                  <ErrorMessage error={products.error} />
                  <button className="button secondary" onClick={products.retry}>
                    Retry products
                  </button>
                </div>
              ) : !products.loading && products.data?.data.length === 0 ? (
                <EmptyState
                  title="No products found"
                  description={
                    search || filter !== "all"
                      ? "Try another search or filter to find your products."
                      : "Add your first product to start tracking inventory."
                  }
                  action={
                    <button
                      className="button secondary"
                      onClick={() => {
                        if (search || filter !== "all") {
                          setSearch("");
                          setFilter("all");
                          setPage(1);
                        } else setDialog({ type: "add" });
                      }}
                    >
                      {search || filter !== "all"
                        ? "Clear filters"
                        : "Add product"}
                    </button>
                  }
                />
              ) : (
                <div className="table-scroll">
                  <table className="products-table">
                    <thead>
                      <tr>
                        <th>SKU</th>
                        <th>Product name</th>
                        <th>Price</th>
                        <th>Stock</th>
                        <th>Status</th>
                        <th>Last movement</th>
                        <th className="align-right">Actions</th>
                      </tr>
                    </thead>
                    {products.loading ? (
                      <LoadingRows columns={7} />
                    ) : (
                      <tbody>
                        {products.data?.data.map((product) => (
                          <tr key={product.id}>
                            <td className="sku">{product.sku}</td>
                            <td>
                              <div className="product-name">
                                <span
                                  className={`product-avatar ${product.sku.startsWith("COF") || product.sku.startsWith("BEA") ? "coffee" : product.sku.startsWith("TEA") ? "tea" : ""}`}
                                >
                                  <Icon name="box" size={18} />
                                </span>
                                <strong>{product.name}</strong>
                              </div>
                            </td>
                            <td className="money">{rupiah(product.price)}</td>
                            <td>
                              <span
                                className={`stock-count ${product.stock <= 10 ? "low" : ""}`}
                              >
                                {product.stock <= 10 && (
                                  <span className="small-dot" />
                                )}
                                {count(product.stock)}
                              </span>
                              <span className="units"> units</span>
                            </td>
                            <td>
                              <span
                                className={`badge ${product.is_active ? "active" : "inactive"}`}
                              >
                                <span />
                                {product.is_active ? "Active" : "Inactive"}
                              </span>
                            </td>
                            <td className="movement-time">
                              <time
                                title={
                                  product.last_movement_at
                                    ? dateTime(product.last_movement_at)
                                    : undefined
                                }
                              >
                                {relativeTime(product.last_movement_at, clock)}
                              </time>
                            </td>
                            <td>
                              <div className="row-actions">
                                <button
                                  className="adjust-button"
                                  aria-label={`Adjust stock for ${product.sku}`}
                                  onClick={() =>
                                    setDialog({ type: "stock", product })
                                  }
                                >
                                  <Icon name="arrow" size={15} />
                                  Adjust
                                </button>
                                <button
                                  className="icon-button"
                                  title="Movement history"
                                  aria-label={`History for ${product.sku}`}
                                  onClick={() =>
                                    setDialog({ type: "history", product })
                                  }
                                >
                                  <Icon name="history" size={16} />
                                </button>
                                <button
                                  className="icon-button"
                                  title="Edit product"
                                  aria-label={`Edit ${product.sku}`}
                                  onClick={() =>
                                    setDialog({ type: "edit", product })
                                  }
                                >
                                  <Icon name="edit" size={16} />
                                </button>
                                <button
                                  className="icon-button delete-action"
                                  title="Delete product"
                                  aria-label={`Delete ${product.sku}`}
                                  onClick={() =>
                                    setDialog({ type: "delete", product })
                                  }
                                >
                                  <Icon name="trash" size={16} />
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    )}
                  </table>
                </div>
              )}
              {!products.error && products.data && !products.loading && (
                <Pagination
                  page={page}
                  total={products.data.total}
                  onChange={setPage}
                />
              )}
            </section>
          ) : (
            <section className="panel" aria-label="Sales order list">
              <div className="panel-heading">
                <div>
                  <h2>
                    All orders{" "}
                    <span className="count-chip">
                      {orders.data?.total ?? "—"}
                    </span>
                  </h2>
                  <p>
                    Stock and prices are confirmed when each order is created.
                  </p>
                </div>
                <button className="button secondary small" onClick={refresh}>
                  <Icon name="history" size={16} />
                  Refresh
                </button>
              </div>
              {orders.error ? (
                <div className="panel-state">
                  <ErrorMessage error={orders.error} />
                  <button className="button secondary" onClick={orders.retry}>
                    Retry orders
                  </button>
                </div>
              ) : !orders.loading && orders.data?.data.length === 0 ? (
                <EmptyState
                  title="No sales orders yet"
                  description="Create an order to record a sale and update your inventory."
                />
              ) : (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Order</th>
                        <th>Customer</th>
                        <th>Created</th>
                        <th>Status</th>
                        <th>Total</th>
                        <th className="align-right">Actions</th>
                      </tr>
                    </thead>
                    {orders.loading ? (
                      <LoadingRows columns={6} />
                    ) : (
                      <tbody>
                        {orders.data?.data.map((order) => (
                          <tr key={order.id}>
                            <td className="sku">
                              #{String(order.id).padStart(4, "0")}
                            </td>
                            <td>
                              <strong>{order.customer}</strong>
                            </td>
                            <td>{dateTime(order.created_at)}</td>
                            <td>
                              <span
                                className={`badge ${order.status === "CREATED" ? "active" : "inactive"}`}
                              >
                                {order.status === "CREATED"
                                  ? "Created"
                                  : "Cancelled"}
                              </span>
                            </td>
                            <td className="money">{rupiah(order.total)}</td>
                            <td className="align-right">
                              <button
                                className="button secondary small"
                                onClick={() =>
                                  setDialog({ type: "order", id: order.id })
                                }
                              >
                                View order
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    )}
                  </table>
                </div>
              )}
              {orders.data && !orders.loading && !orders.error && (
                <Pagination
                  page={orderPage}
                  total={orders.data.total}
                  onChange={setOrderPage}
                />
              )}
            </section>
          )}
          <div className="page-footnote">
            <Icon name="history" size={14} />
            <span>All stock changes are recorded in movement history.</span>
            <span className="footnote-right">
              Prices in Indonesian Rupiah (IDR)
            </span>
          </div>
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          <Icon name="check" size={18} />
          {toast}
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setToast("")}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      )}
      {dialog?.type === "add" && (
        <ProductEditor onClose={() => setDialog(null)} onSaved={saved} />
      )}
      {dialog?.type === "edit" && (
        <ProductEditor
          product={dialog.product}
          onClose={() => setDialog(null)}
          onSaved={saved}
        />
      )}
      {dialog?.type === "stock" && (
        <StockDialog
          product={dialog.product}
          onClose={() => setDialog(null)}
          onSaved={saved}
        />
      )}
      {dialog?.type === "history" && (
        <HistoryDialog
          product={dialog.product}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.type === "delete" && (
        <DeleteDialog
          product={dialog.product}
          onClose={() => setDialog(null)}
          onSaved={saved}
        />
      )}
      {dialog?.type === "create-order" && (
        <CreateOrderDialog
          onClose={() => setDialog(null)}
          onCreated={(order) => {
            changed(`Order #${order.id} created.`);
            setDialog({ type: "order", id: order.id });
          }}
        />
      )}
      {dialog?.type === "order" && (
        <OrderDetailDialog
          key={dialog.id}
          id={dialog.id}
          onClose={() => setDialog(null)}
          onChanged={changed}
        />
      )}
    </div>
  );
}
